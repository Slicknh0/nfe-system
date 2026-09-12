/**
 * Erros de comunicação com a SEFAZ.
 *
 * Depois de uma falha, a pergunta que importa não é "deu erro?", e sim "a
 * SEFAZ pode ter processado?". `phase` responde isso e alimenta
 * `outcomeUnknown` do `TechnicalError`, que decide entre voltar à fila e
 * reconciliar.
 */

import { TechnicalError } from '@nfe/core';

export type SefazOperation = 'AUTHORIZATION' | 'PROTOCOL_QUERY' | 'NUMBER_VOID';

/**
 * - `NOT_SENT`: a requisição comprovadamente não saiu (conexão recusada, DNS,
 *   handshake TLS). Nada foi processado.
 * - `SENT_WITHOUT_RESPONSE`: a requisição saiu e a resposta não voltou
 *   (timeout, conexão resetada). A SEFAZ pode ter processado.
 *
 * Na dúvida, a classificação correta é `SENT_WITHOUT_RESPONSE`.
 */
export type RequestPhase = 'NOT_SENT' | 'SENT_WITHOUT_RESPONSE';

export class SefazCommunicationError extends TechnicalError {
  constructor(
    readonly operation: SefazOperation,
    readonly phase: RequestPhase,
    message: string,
    cause?: unknown,
  ) {
    super(message, phase === 'SENT_WITHOUT_RESPONSE', cause);
  }
}

/** Configuração que o sistema se recusa a executar — por exemplo, mock em produção. */
export class ProviderConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderConfigurationError';
  }
}
