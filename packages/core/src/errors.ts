/**
 * Hierarquia de erros do domínio fiscal.
 *
 * A separação entre erro fiscal e erro técnico não é cosmética: ela decide o
 * que acontece com o documento e o que o usuário deve fazer.
 *
 * - **Fiscal** — a SEFAZ ou a validação local disseram "não". O desfecho é
 *   conhecido, o documento tem destino definido, e a ação é corrigir o dado.
 *   Repetir a operação sem mudar nada dá o mesmo "não".
 *
 * - **Técnico** — timeout, TLS, DNS, fila fora do ar. O desfecho é *desconhecido*.
 *   O documento pode ter sido processado sem que a resposta chegasse. A ação é
 *   consultar o resultado, nunca reenviar às cegas.
 *
 * Tratar os dois como "deu erro" é o que produz NF-e duplicada.
 */

export type ErrorKind = 'FISCAL' | 'TECHNICAL';

export abstract class NfeError extends Error {
  abstract readonly kind: ErrorKind;

  /**
   * Se a mesma operação pode ser repetida sem alterar a entrada.
   *
   * `false` para erro fiscal: repetir dá o mesmo resultado.
   * Para erro técnico, isso indica apenas que a operação é *segura* de repetir —
   * a autorização de NF-e não é, e por isso resolve por consulta.
   */
  abstract readonly retryable: boolean;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Erro de natureza fiscal ou de negócio: rejeição, dado inválido, regra
 * incompatível, documento fora do leiaute.
 */
export abstract class FiscalError extends NfeError {
  readonly kind = 'FISCAL' as const;
  readonly retryable = false;
}

/**
 * Erro de infraestrutura: rede, indisponibilidade, falha interna.
 *
 * `outcomeUnknown` distingue a falha que aconteceu antes de a requisição sair
 * (desfecho conhecido: nada foi processado) daquela em que a requisição pode
 * ter sido processada sem que a resposta voltasse. Só a segunda exige
 * reconciliação.
 */
export abstract class TechnicalError extends NfeError {
  readonly kind = 'TECHNICAL' as const;
  readonly retryable = true;

  constructor(
    message: string,
    readonly outcomeUnknown: boolean,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

export function isFiscalError(error: unknown): error is FiscalError {
  return error instanceof NfeError && error.kind === 'FISCAL';
}

export function isTechnicalError(error: unknown): error is TechnicalError {
  return error instanceof NfeError && error.kind === 'TECHNICAL';
}

/**
 * Se o erro deixa o documento com desfecho desconhecido — isto é, se exige
 * reconciliação em vez de nova tentativa.
 */
export function requiresReconciliation(error: unknown): boolean {
  return isTechnicalError(error) && error.outcomeUnknown;
}
