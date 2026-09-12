/**
 * `@nfe/certificates` — certificado A1 (PKCS#12), regras de uso da NF-e e
 * guarda cifrada do PFX e da senha.
 */

export {
  CertificateError,
  SecretVaultError,
  type CertificateFailureReason,
  type VaultFailureReason,
} from './errors.js';

export { ICP_BRASIL_CNPJ_OID, extractIcpBrasilCnpj } from './icp-brasil.js';

export {
  assertCertificateUsable,
  loadA1Certificate,
  type A1Certificate,
  type CertificatePurpose,
  type UsageCheck,
} from './a1-certificate.js';

export {
  createKeyring,
  openSecret,
  parseMasterKey,
  sealSecret,
  type Keyring,
  type MasterKey,
} from './secret-vault.js';

export {
  openCertificate,
  sealCertificate,
  type CertificateOwner,
  type CertificateSealing,
  type SealedCertificate,
} from './sealed-certificate.js';
