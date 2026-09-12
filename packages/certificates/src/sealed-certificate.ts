/**
 * Certificado A1 guardado cifrado: PFX e senha em segredos separados.
 *
 * O certificado é aberto e conferido ANTES de ser guardado — senha errada ou
 * PFX sem chave são recusados no cadastro, e não na primeira emissão.
 */

import { loadA1Certificate, type A1Certificate } from './a1-certificate.js';
import { openSecret, sealSecret, type Keyring, type MasterKey } from './secret-vault.js';

export interface CertificateOwner {
  readonly tenantId: string;
  readonly issuerId: string;
}

export interface SealedCertificate {
  readonly sealedPfx: string;
  readonly sealedPassphrase: string;
}

export interface CertificateSealing {
  readonly sealed: SealedCertificate;
  /** Dados públicos do certificado, para exibir e para conferir validade. */
  readonly certificate: A1Certificate;
}

function context(owner: CertificateOwner, part: 'pfx' | 'passphrase'): string {
  return `issuer-certificate:${owner.tenantId}:${owner.issuerId}:${part}`;
}

export function sealCertificate(
  pfx: Uint8Array,
  passphrase: string,
  owner: CertificateOwner,
  key: MasterKey,
): CertificateSealing {
  const certificate = loadA1Certificate(pfx, passphrase);
  return {
    certificate,
    sealed: {
      sealedPfx: sealSecret(pfx, key, context(owner, 'pfx')),
      sealedPassphrase: sealSecret(passphrase, key, context(owner, 'passphrase')),
    },
  };
}

export function openCertificate(
  sealed: SealedCertificate,
  owner: CertificateOwner,
  keyring: Keyring,
): A1Certificate {
  const pfx = openSecret(sealed.sealedPfx, keyring, context(owner, 'pfx'));
  const passphrase = openSecret(sealed.sealedPassphrase, keyring, context(owner, 'passphrase'));
  try {
    return loadA1Certificate(pfx, passphrase.toString('utf8'));
  } finally {
    pfx.fill(0);
    passphrase.fill(0);
  }
}
