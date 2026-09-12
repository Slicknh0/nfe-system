/**
 * Contrato entre a aplicação e a SEFAZ autorizadora.
 *
 * O resultado é uma união discriminada, e não um booleano ou um cStat cru:
 * cada variante tem tratamento próprio no fluxo de emissão, e o compilador
 * obriga o chamador a considerar todas.
 *
 * Falha técnica não é variante de resultado — é `SefazCommunicationError`,
 * lançada. Resposta recebida da SEFAZ, mesmo de rejeição, é resultado.
 */

import type { Environment } from '@nfe/core';

export type EnvironmentCode = (typeof Environment)[keyof typeof Environment];

export interface AuthorizationRequest {
  readonly environment: EnvironmentCode;
  readonly accessKey: string;
  /** XML assinado, exatamente o que foi persistido. */
  readonly signedXml: string;
}

export interface ProtocolQueryRequest {
  readonly environment: EnvironmentCode;
  readonly accessKey: string;
}

/** Protocolo de autorização ou denegação — `protNFe/infProt`. */
export interface InvoiceProtocol {
  readonly accessKey: string;
  readonly statusCode: number;
  readonly statusReason: string;
  /** `nProt` — tipo `TProt`: 15 ou 17 dígitos. */
  readonly protocolNumber: string;
  /** `dhRecbto` */
  readonly receivedAt: Date;
  /** `digVal` — digest da NF-e registrado pela SEFAZ. Opcional no schema. */
  readonly digestValue?: string;
}

export interface StatusReply {
  readonly statusCode: number;
  readonly statusReason: string;
}

export type AuthorizationResult =
  | { readonly kind: 'AUTHORIZED'; readonly protocol: InvoiceProtocol }
  | { readonly kind: 'DENIED'; readonly protocol: InvoiceProtocol }
  /** Rejeição: desfecho conhecido, nada foi registrado na SEFAZ. */
  | ({ readonly kind: 'REJECTED' } & StatusReply)
  /** 204/539: já existe NF-e com esta numeração — um envio anterior pode ter sido autorizado. */
  | ({ readonly kind: 'DUPLICATE' } & StatusReply)
  /** 103/105: recebido; o resultado sai por consulta. */
  | ({ readonly kind: 'IN_PROCESSING' } & StatusReply)
  /** 108/109: serviço paralisado, nada processado. */
  | ({ readonly kind: 'SERVICE_UNAVAILABLE' } & StatusReply)
  /** Código fora das tabelas conhecidas: não se presume desfecho. */
  | ({ readonly kind: 'UNRECOGNIZED' } & StatusReply);

export type ProtocolQueryResult =
  | { readonly kind: 'AUTHORIZED'; readonly protocol: InvoiceProtocol }
  | { readonly kind: 'DENIED'; readonly protocol: InvoiceProtocol }
  | ({ readonly kind: 'CANCELLED' } & StatusReply)
  /** 217: a SEFAZ não tem a NF-e — o que não prova que ela não esteja na fila. */
  | ({ readonly kind: 'NOT_FOUND' } & StatusReply)
  | ({ readonly kind: 'SERVICE_UNAVAILABLE' } & StatusReply)
  /** A consulta em si foi recusada (ambiente, UF, chave inválida). */
  | ({ readonly kind: 'QUERY_REJECTED' } & StatusReply)
  | ({ readonly kind: 'UNRECOGNIZED' } & StatusReply);

export interface SefazProvider {
  /** Identificação para log e auditoria. */
  readonly name: string;
  authorize(request: AuthorizationRequest): Promise<AuthorizationResult>;
  queryProtocol(request: ProtocolQueryRequest): Promise<ProtocolQueryResult>;
}
