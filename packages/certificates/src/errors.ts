/**
 * Erros de certificado digital e de cofre de segredos.
 *
 * Nenhuma mensagem inclui senha, chave privada ou conteúdo do PFX. O motivo
 * (`reason`) é estável e serve para a aplicação decidir o que mostrar.
 */

export type CertificateFailureReason =
  | 'UNREADABLE_OR_WRONG_PASSWORD'
  | 'NO_PRIVATE_KEY'
  | 'MULTIPLE_PRIVATE_KEYS'
  | 'NO_CERTIFICATE'
  | 'KEY_CERTIFICATE_MISMATCH'
  | 'NOT_YET_VALID'
  | 'EXPIRED'
  | 'MISSING_CNPJ'
  | 'CNPJ_MISMATCH'
  | 'MISSING_DIGITAL_SIGNATURE'
  | 'MISSING_CLIENT_AUTHENTICATION';

export class CertificateError extends Error {
  constructor(
    readonly reason: CertificateFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'CertificateError';
  }
}

export type VaultFailureReason = 'INVALID_KEY' | 'UNKNOWN_KEY' | 'MALFORMED' | 'AUTHENTICATION_FAILED';

export class SecretVaultError extends Error {
  constructor(
    readonly reason: VaultFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'SecretVaultError';
  }
}
