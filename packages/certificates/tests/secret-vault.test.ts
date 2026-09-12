import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  SecretVaultError,
  createKeyring,
  openCertificate,
  openSecret,
  parseMasterKey,
  sealCertificate,
  sealSecret,
  type VaultFailureReason,
} from '../src/index.js';
import { TestPki } from './support/test-pki.js';

const key = parseMasterKey('chave-2026', randomBytes(32).toString('base64'));
const keyring = createKeyring(key);
const CONTEXT = 'issuer-certificate:tenant-a:issuer-a:passphrase';

function reasonOf(action: () => unknown): VaultFailureReason | undefined {
  try {
    action();
  } catch (error) {
    if (error instanceof SecretVaultError) {
      return error.reason;
    }
    throw error;
  }
  return undefined;
}

describe('cofre de segredos', () => {
  it('abre o que selou, e o texto cifrado não contém o segredo', () => {
    const sealed = sealSecret('senha-do-certificado', key, CONTEXT);

    expect(sealed.startsWith('nfev1.chave-2026.')).toBe(true);
    expect(sealed).not.toContain('senha-do-certificado');
    expect(openSecret(sealed, keyring, CONTEXT).toString('utf8')).toBe('senha-do-certificado');
  });

  it('dois selamentos do mesmo segredo produzem textos diferentes', () => {
    expect(sealSecret('mesmo segredo', key, CONTEXT)).not.toBe(sealSecret('mesmo segredo', key, CONTEXT));
  });

  it('segredo levado para outro contexto (outro tenant ou emitente) não abre', () => {
    const sealed = sealSecret('senha', key, CONTEXT);
    expect(reasonOf(() => openSecret(sealed, keyring, 'issuer-certificate:tenant-b:issuer-a:passphrase'))).toBe(
      'AUTHENTICATION_FAILED',
    );
  });

  it('texto cifrado adulterado não abre', () => {
    const parts = sealSecret('senha', key, CONTEXT).split('.');
    const ciphertext = Buffer.from(parts[4]!, 'base64url');
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 0xff;
    parts[4] = ciphertext.toString('base64url');
    expect(reasonOf(() => openSecret(parts.join('.'), keyring, CONTEXT))).toBe('AUTHENTICATION_FAILED');
  });

  it('rotação: segredo antigo abre enquanto a chave antiga estiver no chaveiro', () => {
    const oldKey = parseMasterKey('chave-2025', randomBytes(32).toString('base64'));
    const sealed = sealSecret('senha', oldKey, CONTEXT);

    expect(openSecret(sealed, createKeyring(key, oldKey), CONTEXT).toString('utf8')).toBe('senha');
    expect(reasonOf(() => openSecret(sealed, keyring, CONTEXT))).toBe('UNKNOWN_KEY');
  });

  it('recusa chave mestra de tamanho errado e formato desconhecido', () => {
    expect(reasonOf(() => parseMasterKey('curta', randomBytes(16).toString('base64')))).toBe('INVALID_KEY');
    expect(reasonOf(() => parseMasterKey('id inválido', randomBytes(32).toString('base64')))).toBe('INVALID_KEY');
    expect(reasonOf(() => openSecret('texto-qualquer', keyring, CONTEXT))).toBe('MALFORMED');
  });
});

describe('certificado A1 selado', () => {
  let pki: TestPki;

  beforeAll(() => {
    pki = new TestPki();
  });

  it('confere o certificado antes de guardar e o recupera com o mesmo contexto', () => {
    const owner = { tenantId: 'tenant-a', issuerId: 'issuer-a' };
    const pfx = pki.toPfx(pki.issue({ cnpj: '11222333000181', clientAuth: true }), 'senha-do-pfx');

    const { sealed, certificate } = sealCertificate(pfx, 'senha-do-pfx', owner, key);
    expect(certificate.cnpj).toBe('11222333000181');
    expect(sealed.sealedPassphrase).not.toContain('senha-do-pfx');
    expect(sealed.sealedPfx).not.toContain(pfx.toString('base64'));

    const reopened = openCertificate(sealed, owner, keyring);
    expect(reopened.fingerprint256).toBe(certificate.fingerprint256);
  });

  it('senha errada é recusada já no cadastro', () => {
    const pfx = pki.toPfx(pki.issue({ cnpj: '11222333000181' }), 'senha-certa');
    expect(() => sealCertificate(pfx, 'senha-errada', { tenantId: 't', issuerId: 'i' }, key)).toThrow();
  });

  it('segredos trocados entre emitentes não abrem', () => {
    const pfx = pki.toPfx(pki.issue({ cnpj: '11222333000181' }), 'senha-do-pfx');
    const { sealed } = sealCertificate(pfx, 'senha-do-pfx', { tenantId: 'tenant-a', issuerId: 'issuer-a' }, key);

    expect(() => openCertificate(sealed, { tenantId: 'tenant-a', issuerId: 'issuer-b' }, keyring)).toThrow(
      SecretVaultError,
    );
  });
});
