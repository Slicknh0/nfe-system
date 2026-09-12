/**
 * Interpretação dos códigos de resultado (cStat) da SEFAZ.
 *
 * Fonte: MOC 7.0, Anexo I — itens 4.4.1 (Resultado de Processamento), 4.4.2
 * (Rejeição) e 4.4.3 (Denegação de Uso); MOC 7.0, Visão Geral — item 5.2.5 e
 * regra J03 do item 5.4.4. Só estão nomeados códigos conferidos no texto
 * oficial.
 *
 * Autorização e denegação são listas fechadas. Rejeição é a tabela 4.4.2: o
 * código 142 e a faixa 2xx–9xx. Código fora dessas tabelas NÃO vira rejeição
 * por eliminação — vira `UNRECOGNIZED`, e o fluxo de emissão não presume
 * desfecho a partir dele.
 */

import type {
  AuthorizationResult,
  InvoiceProtocol,
  ProtocolQueryResult,
  StatusReply,
} from './provider.js';

export const SefazStatus = Object.freeze({
  AUTHORIZED: 100,
  CANCELLED: 101,
  BATCH_RECEIVED: 103,
  BATCH_PROCESSED: 104,
  BATCH_IN_PROCESSING: 105,
  SERVICE_PAUSED_SHORT_TERM: 108,
  SERVICE_PAUSED_NO_FORECAST: 109,
  DENIED: 110,
  AUTHORIZED_OUT_OF_TIME: 150,
  CANCELLED_OUT_OF_TIME: 151,
  DUPLICATE_INVOICE: 204,
  INVOICE_NOT_FOUND: 217,
  DENIED_ISSUER_IRREGULAR: 301,
  DENIED_RECIPIENT_IRREGULAR: 302,
  DENIED_RECIPIENT_NOT_ENABLED: 303,
  DUPLICATE_INVOICE_DIFFERENT_KEY: 539,
} as const);

const AUTHORIZED = new Set<number>([SefazStatus.AUTHORIZED, SefazStatus.AUTHORIZED_OUT_OF_TIME]);

/** 110 é o código genérico de 4.4.1; 301–303 são a tabela 4.4.3 inteira. */
const DENIED = new Set<number>([
  SefazStatus.DENIED,
  SefazStatus.DENIED_ISSUER_IRREGULAR,
  SefazStatus.DENIED_RECIPIENT_IRREGULAR,
  SefazStatus.DENIED_RECIPIENT_NOT_ENABLED,
]);

/**
 * Duplicidade é rejeição na tabela oficial, mas tem outro significado para o
 * emissor: já existe NF-e com esta numeração na SEFAZ. Pode ser um envio
 * anterior deste mesmo documento, autorizado sem que a resposta chegasse.
 */
const DUPLICATE = new Set<number>([
  SefazStatus.DUPLICATE_INVOICE,
  SefazStatus.DUPLICATE_INVOICE_DIFFERENT_KEY,
]);

const CANCELLED = new Set<number>([SefazStatus.CANCELLED, SefazStatus.CANCELLED_OUT_OF_TIME]);

const IN_PROCESSING = new Set<number>([SefazStatus.BATCH_RECEIVED, SefazStatus.BATCH_IN_PROCESSING]);

const SERVICE_UNAVAILABLE = new Set<number>([
  SefazStatus.SERVICE_PAUSED_SHORT_TERM,
  SefazStatus.SERVICE_PAUSED_NO_FORECAST,
]);

/** Único código da tabela 4.4.2 abaixo de 200. */
const REJECTION_CODES_BELOW_200 = new Set<number>([142]);

function isRejectionCode(code: number): boolean {
  return REJECTION_CODES_BELOW_200.has(code) || (Number.isInteger(code) && code >= 200 && code <= 999);
}

export type ProtocolStatusClass = 'AUTHORIZED' | 'DENIED' | 'DUPLICATE' | 'REJECTED' | 'UNRECOGNIZED';

/** Classifica o `cStat` de `protNFe/infProt`. */
export function classifyProtocolStatus(code: number): ProtocolStatusClass {
  if (AUTHORIZED.has(code)) {
    return 'AUTHORIZED';
  }
  if (DENIED.has(code)) {
    return 'DENIED';
  }
  if (DUPLICATE.has(code)) {
    return 'DUPLICATE';
  }
  return isRejectionCode(code) ? 'REJECTED' : 'UNRECOGNIZED';
}

function reply(source: StatusReply): StatusReply {
  return { statusCode: source.statusCode, statusReason: source.statusReason };
}

/** Resposta de `nfeAutorizacao` já extraída do SOAP. */
export interface AuthorizationResponse {
  /** `retEnviNFe/cStat` e `xMotivo`. */
  readonly batch: StatusReply;
  /** `retEnviNFe/protNFe/infProt`, presente no processamento síncrono. */
  readonly protocol?: InvoiceProtocol;
}

export function interpretAuthorizationResponse(response: AuthorizationResponse): AuthorizationResult {
  const { batch, protocol } = response;

  if (batch.statusCode === SefazStatus.BATCH_PROCESSED) {
    if (protocol === undefined) {
      return { kind: 'UNRECOGNIZED', ...reply(batch) };
    }
    switch (classifyProtocolStatus(protocol.statusCode)) {
      case 'AUTHORIZED':
        return { kind: 'AUTHORIZED', protocol };
      case 'DENIED':
        return { kind: 'DENIED', protocol };
      case 'DUPLICATE':
        return { kind: 'DUPLICATE', ...reply(protocol) };
      case 'REJECTED':
        return { kind: 'REJECTED', ...reply(protocol) };
      case 'UNRECOGNIZED':
        return { kind: 'UNRECOGNIZED', ...reply(protocol) };
    }
  }

  if (IN_PROCESSING.has(batch.statusCode)) {
    return { kind: 'IN_PROCESSING', ...reply(batch) };
  }
  if (SERVICE_UNAVAILABLE.has(batch.statusCode)) {
    return { kind: 'SERVICE_UNAVAILABLE', ...reply(batch) };
  }
  if (DUPLICATE.has(batch.statusCode)) {
    return { kind: 'DUPLICATE', ...reply(batch) };
  }
  if (isRejectionCode(batch.statusCode)) {
    return { kind: 'REJECTED', ...reply(batch) };
  }
  return { kind: 'UNRECOGNIZED', ...reply(batch) };
}

/** Resposta de `nfeConsultaProtocolo` já extraída do SOAP. */
export interface ProtocolQueryResponse {
  /** `retConsSitNFe/cStat` e `xMotivo`. */
  readonly status: StatusReply;
  /** `retConsSitNFe/protNFe/infProt`, quando a NF-e foi localizada. */
  readonly protocol?: InvoiceProtocol;
}

export function interpretProtocolQueryResponse(response: ProtocolQueryResponse): ProtocolQueryResult {
  const { status, protocol } = response;
  const code = status.statusCode;

  if (AUTHORIZED.has(code) || DENIED.has(code)) {
    // A Visão Geral (5.4.2) diz que o protocolo acompanha esses códigos. Sem ele
    // não há número de protocolo para registrar, e o resultado não é aceito.
    if (protocol === undefined) {
      return { kind: 'UNRECOGNIZED', ...reply(status) };
    }
    return AUTHORIZED.has(code) ? { kind: 'AUTHORIZED', protocol } : { kind: 'DENIED', protocol };
  }
  if (CANCELLED.has(code)) {
    return { kind: 'CANCELLED', ...reply(status) };
  }
  if (code === SefazStatus.INVOICE_NOT_FOUND) {
    return { kind: 'NOT_FOUND', ...reply(status) };
  }
  if (SERVICE_UNAVAILABLE.has(code)) {
    return { kind: 'SERVICE_UNAVAILABLE', ...reply(status) };
  }
  if (isRejectionCode(code)) {
    return { kind: 'QUERY_REJECTED', ...reply(status) };
  }
  return { kind: 'UNRECOGNIZED', ...reply(status) };
}
