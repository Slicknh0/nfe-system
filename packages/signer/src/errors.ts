/**
 * Falhas de assinatura.
 *
 * O pacote de assinatura não depende de `@nfe/core`: ele é isolado de
 * propósito, e a classificação em erro fiscal ou técnico acontece na camada de
 * aplicação, que conhece o contexto da emissão. O `reason` estável permite essa
 * tradução sem depender do texto da mensagem.
 *
 * Nenhuma mensagem inclui material de chave, senha ou conteúdo do certificado.
 */

export type SignatureFailureReason =
  | 'INVALID_CREDENTIALS'
  | 'KEY_CERTIFICATE_MISMATCH'
  | 'CERTIFICATE_NOT_YET_VALID'
  | 'CERTIFICATE_EXPIRED'
  | 'DOCUMENT_NOT_SIGNABLE'
  | 'ALREADY_SIGNED';

export class XmlSignatureError extends Error {
  constructor(
    readonly reason: SignatureFailureReason,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = 'XmlSignatureError';
  }
}
