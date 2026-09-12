/**
 * SEFAZ simulada para desenvolvimento e testes.
 *
 * Mantém em memória um registro das NF-e "recebidas". Assim a consulta
 * responde de forma coerente com o que aconteceu no envio, inclusive quando a
 * resposta se perdeu. É isso que permite testar reconciliação de verdade.
 *
 * Recusa ambiente de produção em toda chamada. Os textos de `xMotivo` são os
 * da tabela oficial (MOC 7.0, Anexo I, itens 4.4.1 a 4.4.3). Números de
 * protocolo são fictícios, apenas no formato de `TProt`.
 */

import { Environment } from '@nfe/core';
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
  ProtocolQueryRequest,
  ProtocolQueryResult,
  SefazProvider,
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
  | { readonly type: 'lose-request' };

export type MockQueryBehavior =
  | { readonly type: 'answer' }
  | { readonly type: 'fail-before-sending' }
  | { readonly type: 'lose-response' };

export interface MockSefazCall {
  readonly operation: SefazOperation;
  readonly accessKey: string;
}

export interface MockSefazOptions {
  readonly now?: () => Date;
}

const REASONS: Readonly<Record<number, string>> = Object.freeze({
  [SefazStatus.AUTHORIZED]: 'Autorizado o uso da NF-e',
  [SefazStatus.BATCH_RECEIVED]: 'Lote recebido com sucesso',
  [SefazStatus.SERVICE_PAUSED_SHORT_TERM]: 'Serviço Paralisado Momentaneamente (curto prazo)',
  [SefazStatus.DUPLICATE_INVOICE]: 'Rejeição: Duplicidade de NF-e',
  [SefazStatus.INVOICE_NOT_FOUND]: 'Rejeição: NF-e não consta na base de dados da SEFAZ',
  [SefazStatus.DENIED_ISSUER_IRREGULAR]: 'Uso Denegado: Irregularidade fiscal do emitente',
  [SefazStatus.DENIED_RECIPIENT_IRREGULAR]: 'Uso Denegado: Irregularidade fiscal do destinatário',
  [SefazStatus.DENIED_RECIPIENT_NOT_ENABLED]: 'Uso Denegado: Destinatário não habilitado a operar na UF',
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
  private readonly authorizationBehaviors: MockAuthorizationBehavior[] = [];
  private readonly queryBehaviors: MockQueryBehavior[] = [];
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

  get calls(): readonly MockSefazCall[] {
    return this.recordedCalls;
  }

  countCalls(operation: SefazOperation, accessKey?: string): number {
    return this.recordedCalls.filter(
      (call) =>
        call.operation === operation && (accessKey === undefined || call.accessKey === accessKey),
    ).length;
  }

  authorize(request: AuthorizationRequest): Promise<AuthorizationResult> {
    return Promise.resolve().then(() => this.authorizeNow(request));
  }

  queryProtocol(request: ProtocolQueryRequest): Promise<ProtocolQueryResult> {
    return Promise.resolve().then(() => this.queryNow(request));
  }

  private authorizeNow(request: AuthorizationRequest): AuthorizationResult {
    refuseProduction(request.environment);
    if (!request.signedXml.includes(`Id="NFe${request.accessKey}"`)) {
      throw new ProviderConfigurationError(
        'O XML enviado não corresponde à chave de acesso informada.',
      );
    }
    this.recordedCalls.push({ operation: 'AUTHORIZATION', accessKey: request.accessKey });

    const behavior: MockAuthorizationBehavior = this.authorizationBehaviors.shift() ?? {
      type: 'authorize',
    };

    if (behavior.type === 'fail-before-sending') {
      throw new SefazCommunicationError('AUTHORIZATION', 'NOT_SENT', 'Conexão recusada (simulada).');
    }
    if (behavior.type === 'lose-request') {
      throw lostResponse('AUTHORIZATION');
    }
    if (behavior.type === 'service-unavailable') {
      return {
        kind: 'SERVICE_UNAVAILABLE',
        statusCode: SefazStatus.SERVICE_PAUSED_SHORT_TERM,
        statusReason: reason(SefazStatus.SERVICE_PAUSED_SHORT_TERM),
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
    this.recordedCalls.push({ operation: 'PROTOCOL_QUERY', accessKey: request.accessKey });

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

  private register(request: AuthorizationRequest, statusCode: number): InvoiceProtocol {
    this.protocolSequence += 1;
    const digestValue = /<DigestValue>([^<]+)<\/DigestValue>/.exec(request.signedXml)?.[1];
    const protocol: InvoiceProtocol = {
      accessKey: request.accessKey,
      statusCode,
      statusReason: reason(statusCode),
      protocolNumber: String(FIRST_PROTOCOL_NUMBER + this.protocolSequence),
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
