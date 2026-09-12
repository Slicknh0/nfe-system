/**
 * SEFAZ simulada para desenvolvimento e testes.
 *
 * Mantém em memória o que a SEFAZ "sabe": NF-e registradas, pedidos retidos na
 * fila e faixas inutilizadas. Assim consulta e inutilização respondem de forma
 * coerente com o que aconteceu antes — inclusive quando uma resposta se perdeu
 * ou quando a nota ficou na fila e foi processada depois.
 *
 * Recusa ambiente de produção em toda chamada. Os textos de `xMotivo` são os da
 * tabela oficial (MOC 7.0, Anexo I, itens 4.4.1 a 4.4.3). Números de protocolo
 * são fictícios, apenas no formato de `TProt`. As verificações da inutilização
 * seguem a ordem das regras I07, I07a e I08 (MOC 7.0, Visão Geral, 5.3.4).
 */

import { Environment, parseAccessKey } from '@nfe/core';
import {
  ProviderConfigurationError,
  SefazCommunicationError,
  type SefazOperation,
} from './errors.js';
import type {
  AuthorizationRequest,
  AuthorizationResult,
  EnvironmentCode,
  InvoiceProtocol,
  NumberVoidRequest,
  NumberVoidResult,
  ProtocolQueryRequest,
  ProtocolQueryResult,
  SefazProvider,
  VoidProtocol,
} from './provider.js';
import { SefazStatus } from './status-codes.js';

export type DenialCode =
  | typeof SefazStatus.DENIED_ISSUER_IRREGULAR
  | typeof SefazStatus.DENIED_RECIPIENT_IRREGULAR
  | typeof SefazStatus.DENIED_RECIPIENT_NOT_ENABLED;

export type MockAuthorizationBehavior =
  | { readonly type: 'authorize' }
  | { readonly type: 'deny'; readonly statusCode: DenialCode }
  | { readonly type: 'reject'; readonly statusCode: number; readonly statusReason: string }
  /** 103: recebido para processamento; a consulta encontra o resultado. */
  | { readonly type: 'accept-for-processing' }
  /** 108: serviço paralisado momentaneamente. */
  | { readonly type: 'service-unavailable' }
  /** Conexão recusada: a requisição não saiu. */
  | { readonly type: 'fail-before-sending' }
  /** A SEFAZ autoriza, mas a resposta não chega ao emissor. */
  | { readonly type: 'lose-response-after-processing' }
  /** A requisição sai mas não chega à SEFAZ; o emissor vê timeout. */
  | { readonly type: 'lose-request' }
  /**
   * A requisição fica na fila da SEFAZ e o emissor vê timeout. Só é processada
   * em `releaseHeldAuthorizations` — o caso que o Anexo III, 2.3.3, descreve.
   */
  | { readonly type: 'hold-in-queue' };

export type MockQueryBehavior =
  | { readonly type: 'answer' }
  | { readonly type: 'fail-before-sending' }
  | { readonly type: 'lose-response' };

export type MockVoidBehavior =
  | { readonly type: 'answer' }
  | { readonly type: 'fail-before-sending' }
  | { readonly type: 'lose-response-after-processing' }
  | { readonly type: 'lose-request' };

export interface MockSefazCall {
  readonly operation: SefazOperation;
  /** Chave de acesso, ou `CNPJ/série/início-fim` na inutilização. */
  readonly reference: string;
}

export interface MockSefazOptions {
  readonly now?: () => Date;
}

interface VoidedRange {
  readonly cnpj: string;
  readonly series: number;
  readonly firstNumber: number;
  readonly lastNumber: number;
  readonly protocol: VoidProtocol;
}

const REASONS: Readonly<Record<number, string>> = Object.freeze({
  [SefazStatus.AUTHORIZED]: 'Autorizado o uso da NF-e',
  [SefazStatus.NUMBER_VOID_HOMOLOGATED]: 'Inutilização de número homologado',
  [SefazStatus.BATCH_RECEIVED]: 'Lote recebido com sucesso',
  [SefazStatus.SERVICE_PAUSED_SHORT_TERM]: 'Serviço Paralisado Momentaneamente (curto prazo)',
  [SefazStatus.DUPLICATE_INVOICE]: 'Rejeição: Duplicidade de NF-e',
  [SefazStatus.INVOICE_ALREADY_VOIDED]: 'Rejeição: NF-e já está inutilizada na Base de Dados da SEFAZ',
  [SefazStatus.INVOICE_NOT_FOUND]: 'Rejeição: NF-e não consta na base de dados da SEFAZ',
  [SefazStatus.NUMBER_ALREADY_USED]: 'Rejeição: Um número da faixa já foi utilizado',
  [SefazStatus.RANGE_ALREADY_VOIDED]: 'Rejeição: Uma NF-e da faixa já está inutilizada na Base de dados da SEFAZ',
  [SefazStatus.DENIED_ISSUER_IRREGULAR]: 'Uso Denegado: Irregularidade fiscal do emitente',
  [SefazStatus.DENIED_RECIPIENT_IRREGULAR]: 'Uso Denegado: Irregularidade fiscal do destinatário',
  [SefazStatus.DENIED_RECIPIENT_NOT_ENABLED]: 'Uso Denegado: Destinatário não habilitado a operar na UF',
  [SefazStatus.DUPLICATE_VOID_REQUEST]:
    'Rejeição: Já existe pedido de Inutilização com a mesma faixa de inutilização',
});

function reason(code: number): string {
  const text = REASONS[code];
  if (text === undefined) {
    throw new Error(`Mock sem texto oficial para cStat ${code}.`);
  }
  return text;
}

const FIRST_PROTOCOL_NUMBER = 900_000_000_000_000;

export class MockSefazProvider implements SefazProvider {
  readonly name = 'mock';

  private readonly registry = new Map<string, InvoiceProtocol>();
  private readonly held = new Map<string, AuthorizationRequest>();
  private readonly voidedRanges: VoidedRange[] = [];
  private readonly authorizationBehaviors: MockAuthorizationBehavior[] = [];
  private readonly queryBehaviors: MockQueryBehavior[] = [];
  private readonly voidBehaviors: MockVoidBehavior[] = [];
  private readonly recordedCalls: MockSefazCall[] = [];
  private readonly now: () => Date;
  private protocolSequence = 0;

  constructor(options: MockSefazOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  /** Define o comportamento dos próximos envios, em ordem. Sem roteiro, autoriza. */
  scriptAuthorizations(...behaviors: MockAuthorizationBehavior[]): this {
    this.authorizationBehaviors.push(...behaviors);
    return this;
  }

  /** Define o comportamento das próximas consultas, em ordem. Sem roteiro, responde. */
  scriptQueries(...behaviors: MockQueryBehavior[]): this {
    this.queryBehaviors.push(...behaviors);
    return this;
  }

  /** Define o comportamento das próximas inutilizações, em ordem. Sem roteiro, responde. */
  scriptVoids(...behaviors: MockVoidBehavior[]): this {
    this.voidBehaviors.push(...behaviors);
    return this;
  }

  get calls(): readonly MockSefazCall[] {
    return this.recordedCalls;
  }

  countCalls(operation: SefazOperation, reference?: string): number {
    return this.recordedCalls.filter(
      (call) =>
        call.operation === operation && (reference === undefined || call.reference === reference),
    ).length;
  }

  /**
   * Processa os pedidos retidos na fila, como a SEFAZ faria ao voltar à
   * operação normal. Número inutilizado nesse meio-tempo é rejeitado (206) e
   * não gera registro. Devolve quantos foram autorizados.
   */
  releaseHeldAuthorizations(): number {
    let authorized = 0;
    for (const [accessKey, request] of this.held) {
      this.held.delete(accessKey);
      if (this.registry.has(accessKey) || this.isVoided(accessKey)) {
        continue;
      }
      this.register(request, SefazStatus.AUTHORIZED);
      authorized += 1;
    }
    return authorized;
  }

  authorize(request: AuthorizationRequest): Promise<AuthorizationResult> {
    return Promise.resolve().then(() => this.authorizeNow(request));
  }

  queryProtocol(request: ProtocolQueryRequest): Promise<ProtocolQueryResult> {
    return Promise.resolve().then(() => this.queryNow(request));
  }

  voidNumbers(request: NumberVoidRequest): Promise<NumberVoidResult> {
    return Promise.resolve().then(() => this.voidNow(request));
  }

  private authorizeNow(request: AuthorizationRequest): AuthorizationResult {
    refuseProduction(request.environment);
    if (!request.signedXml.includes(`Id="NFe${request.accessKey}"`)) {
      throw new ProviderConfigurationError(
        'O XML enviado não corresponde à chave de acesso informada.',
      );
    }
    this.recordedCalls.push({ operation: 'AUTHORIZATION', reference: request.accessKey });

    const behavior: MockAuthorizationBehavior = this.authorizationBehaviors.shift() ?? {
      type: 'authorize',
    };

    if (behavior.type === 'fail-before-sending') {
      throw new SefazCommunicationError('AUTHORIZATION', 'NOT_SENT', 'Conexão recusada (simulada).');
    }
    if (behavior.type === 'lose-request') {
      throw lostResponse('AUTHORIZATION');
    }
    if (behavior.type === 'hold-in-queue') {
      this.held.set(request.accessKey, request);
      throw lostResponse('AUTHORIZATION');
    }
    if (behavior.type === 'service-unavailable') {
      return {
        kind: 'SERVICE_UNAVAILABLE',
        statusCode: SefazStatus.SERVICE_PAUSED_SHORT_TERM,
        statusReason: reason(SefazStatus.SERVICE_PAUSED_SHORT_TERM),
      };
    }
    if (this.isVoided(request.accessKey)) {
      return {
        kind: 'REJECTED',
        statusCode: SefazStatus.INVOICE_ALREADY_VOIDED,
        statusReason: reason(SefazStatus.INVOICE_ALREADY_VOIDED),
      };
    }

    // A SEFAZ confere duplicidade antes de processar o conteúdo.
    if (this.registry.has(request.accessKey)) {
      if (behavior.type === 'lose-response-after-processing') {
        throw lostResponse('AUTHORIZATION');
      }
      return {
        kind: 'DUPLICATE',
        statusCode: SefazStatus.DUPLICATE_INVOICE,
        statusReason: reason(SefazStatus.DUPLICATE_INVOICE),
      };
    }

    switch (behavior.type) {
      case 'authorize':
        return { kind: 'AUTHORIZED', protocol: this.register(request, SefazStatus.AUTHORIZED) };
      case 'deny':
        return { kind: 'DENIED', protocol: this.register(request, behavior.statusCode) };
      case 'reject':
        return {
          kind: 'REJECTED',
          statusCode: behavior.statusCode,
          statusReason: behavior.statusReason,
        };
      case 'accept-for-processing':
        this.register(request, SefazStatus.AUTHORIZED);
        return {
          kind: 'IN_PROCESSING',
          statusCode: SefazStatus.BATCH_RECEIVED,
          statusReason: reason(SefazStatus.BATCH_RECEIVED),
        };
      case 'lose-response-after-processing':
        this.register(request, SefazStatus.AUTHORIZED);
        throw lostResponse('AUTHORIZATION');
    }
  }

  private queryNow(request: ProtocolQueryRequest): ProtocolQueryResult {
    refuseProduction(request.environment);
    this.recordedCalls.push({ operation: 'PROTOCOL_QUERY', reference: request.accessKey });

    const behavior: MockQueryBehavior = this.queryBehaviors.shift() ?? { type: 'answer' };
    if (behavior.type === 'fail-before-sending') {
      throw new SefazCommunicationError('PROTOCOL_QUERY', 'NOT_SENT', 'Conexão recusada (simulada).');
    }
    if (behavior.type === 'lose-response') {
      throw lostResponse('PROTOCOL_QUERY');
    }

    const protocol = this.registry.get(request.accessKey);
    if (protocol === undefined) {
      return {
        kind: 'NOT_FOUND',
        statusCode: SefazStatus.INVOICE_NOT_FOUND,
        statusReason: reason(SefazStatus.INVOICE_NOT_FOUND),
      };
    }
    return protocol.statusCode === SefazStatus.AUTHORIZED
      ? { kind: 'AUTHORIZED', protocol }
      : { kind: 'DENIED', protocol };
  }

  private voidNow(request: NumberVoidRequest): NumberVoidResult {
    refuseProduction(request.environment);
    const expectedTags = [
      '<xServ>INUTILIZAR</xServ>',
      `<CNPJ>${request.cnpj}</CNPJ>`,
      `<serie>${request.series}</serie>`,
      `<nNFIni>${request.firstNumber}</nNFIni>`,
      `<nNFFin>${request.lastNumber}</nNFFin>`,
    ];
    if (!expectedTags.every((tag) => request.signedXml.includes(tag))) {
      throw new ProviderConfigurationError(
        'O pedido de inutilização enviado não corresponde à faixa informada.',
      );
    }
    this.recordedCalls.push({
      operation: 'NUMBER_VOID',
      reference: `${request.cnpj}/${request.series}/${request.firstNumber}-${request.lastNumber}`,
    });

    const behavior: MockVoidBehavior = this.voidBehaviors.shift() ?? { type: 'answer' };
    if (behavior.type === 'fail-before-sending') {
      throw new SefazCommunicationError('NUMBER_VOID', 'NOT_SENT', 'Conexão recusada (simulada).');
    }
    if (behavior.type === 'lose-request') {
      throw lostResponse('NUMBER_VOID');
    }

    const result = this.answerVoid(request);
    if (behavior.type === 'lose-response-after-processing') {
      throw lostResponse('NUMBER_VOID');
    }
    return result;
  }

  private answerVoid(request: NumberVoidRequest): NumberVoidResult {
    const sameIssuerAndSeries = this.voidedRanges.filter(
      (range) => range.cnpj === request.cnpj && range.series === request.series,
    );

    // I07: pedido idêntico já homologado — a SEFAZ devolve o nProt anterior.
    const identical = sameIssuerAndSeries.find(
      (range) =>
        range.firstNumber === request.firstNumber && range.lastNumber === request.lastNumber,
    );
    if (identical !== undefined) {
      return {
        kind: 'VOIDED',
        protocol: {
          statusCode: SefazStatus.DUPLICATE_VOID_REQUEST,
          statusReason: reason(SefazStatus.DUPLICATE_VOID_REQUEST),
          protocolNumber: identical.protocol.protocolNumber,
          receivedAt: this.now(),
        },
      };
    }

    // I07a: algum número da faixa pertence a uma faixa já inutilizada.
    if (
      sameIssuerAndSeries.some(
        (range) =>
          range.firstNumber <= request.lastNumber && request.firstNumber <= range.lastNumber,
      )
    ) {
      return {
        kind: 'RANGE_ALREADY_VOIDED',
        statusCode: SefazStatus.RANGE_ALREADY_VOIDED,
        statusReason: reason(SefazStatus.RANGE_ALREADY_VOIDED),
      };
    }

    // I08: algum número da faixa já foi usado por NF-e registrada.
    const used = [...this.registry.keys()].some((accessKey) => {
      const key = parseAccessKey(accessKey);
      return (
        key.cnpj === request.cnpj &&
        key.series === request.series &&
        key.number >= request.firstNumber &&
        key.number <= request.lastNumber
      );
    });
    if (used) {
      return {
        kind: 'NUMBER_ALREADY_USED',
        statusCode: SefazStatus.NUMBER_ALREADY_USED,
        statusReason: reason(SefazStatus.NUMBER_ALREADY_USED),
      };
    }

    const protocol: VoidProtocol = {
      statusCode: SefazStatus.NUMBER_VOID_HOMOLOGATED,
      statusReason: reason(SefazStatus.NUMBER_VOID_HOMOLOGATED),
      protocolNumber: this.nextProtocolNumber(),
      receivedAt: this.now(),
    };
    this.voidedRanges.push({
      cnpj: request.cnpj,
      series: request.series,
      firstNumber: request.firstNumber,
      lastNumber: request.lastNumber,
      protocol,
    });
    return { kind: 'VOIDED', protocol };
  }

  private isVoided(accessKey: string): boolean {
    const key = parseAccessKey(accessKey);
    return this.voidedRanges.some(
      (range) =>
        range.cnpj === key.cnpj &&
        range.series === key.series &&
        key.number >= range.firstNumber &&
        key.number <= range.lastNumber,
    );
  }

  private nextProtocolNumber(): string {
    this.protocolSequence += 1;
    return String(FIRST_PROTOCOL_NUMBER + this.protocolSequence);
  }

  private register(request: AuthorizationRequest, statusCode: number): InvoiceProtocol {
    const digestValue = /<DigestValue>([^<]+)<\/DigestValue>/.exec(request.signedXml)?.[1];
    const protocol: InvoiceProtocol = {
      accessKey: request.accessKey,
      statusCode,
      statusReason: reason(statusCode),
      protocolNumber: this.nextProtocolNumber(),
      receivedAt: this.now(),
      ...(digestValue === undefined ? {} : { digestValue }),
    };
    this.registry.set(request.accessKey, protocol);
    return protocol;
  }
}

function refuseProduction(environment: EnvironmentCode): void {
  if (environment !== Environment.Homologation) {
    throw new ProviderConfigurationError(
      'A SEFAZ simulada só atende homologação. Produção exige o provider real.',
    );
  }
}

function lostResponse(operation: SefazOperation): SefazCommunicationError {
  return new SefazCommunicationError(
    operation,
    'SENT_WITHOUT_RESPONSE',
    'Tempo de resposta esgotado (simulado).',
  );
}
