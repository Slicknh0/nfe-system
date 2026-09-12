import { buildUnsignedNfe, calculateCnpjCheckDigits } from '@nfe/core';
import { signNfeXml, verifyNfeSignature } from '@nfe/signer';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeDocument } from '../../core/tests/fixtures/nfe-document.js';
import {
  CertificateError,
  assertCertificateUsable,
  loadA1Certificate,
  type CertificateFailureReason,
} from '../src/index.js';
import { TestPki } from './support/test-pki.js';

const CNPJ = '11222333000181';
const BRANCH_CNPJ = `112223330002${calculateCnpjCheckDigits('112223330002')}`;
const OTHER_COMPANY_CNPJ = `998877660001${calculateCnpjCheckDigits('998877660001')}`;
const PASSPHRASE = 'senha-do-pfx-de-teste';
const DAY = 24 * 60 * 60 * 1000;

let pki: TestPki;

beforeAll(() => {
  pki = new TestPki();
});

function reasonOf(action: () => unknown): CertificateFailureReason | undefined {
  try {
    action();
  } catch (error) {
    if (error instanceof CertificateError) {
      return error.reason;
    }
    throw error;
  }
  return undefined;
}

describe('loadA1Certificate', () => {
  it('extrai chave, certificado, cadeia, validade e o CNPJ do otherName 2.16.76.1.3.3', () => {
    const leaf = pki.issue({ cnpj: CNPJ, clientAuth: true });
    const certificate = loadA1Certificate(pki.toPfx(leaf, PASSPHRASE), PASSPHRASE);

    expect(certificate.cnpj).toBe(CNPJ);
    expect(certificate.certificatePem).toBe(leaf.certificatePem);
    expect(certificate.chainPem).toEqual([pki.root.certificatePem]);
    expect(certificate.privateKeyPem).toContain('PRIVATE KEY');
    expect(certificate.allowsDigitalSignature).toBe(true);
    expect(certificate.allowsClientAuthentication).toBe(true);
    expect(certificate.notAfter.getTime()).toBeGreaterThan(Date.now());
    expect(certificate.fingerprint256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });

  it('lê CNPJ alfanumérico', () => {
    const cnpj = `A1B2C3D4E5F6${calculateCnpjCheckDigits('A1B2C3D4E5F6')}`;
    const certificate = loadA1Certificate(pki.toPfx(pki.issue({ cnpj }), PASSPHRASE), PASSPHRASE);
    expect(certificate.cnpj).toBe(cnpj);
  });

  it('identifica o titular pela chave, mesmo com a AC antes no arquivo', () => {
    const leaf = pki.issue({ cnpj: CNPJ });
    const certificate = loadA1Certificate(pki.toPfx(leaf, PASSPHRASE, { rootFirst: true }), PASSPHRASE);
    expect(certificate.certificatePem).toBe(leaf.certificatePem);
  });

  it('senha incorreta é recusada sem que a senha apareça na mensagem', () => {
    const pfx = pki.toPfx(pki.issue({ cnpj: CNPJ }), PASSPHRASE);
    try {
      loadA1Certificate(pfx, 'senha-errada-123');
      expect.unreachable();
    } catch (error) {
      expect((error as CertificateError).reason).toBe('UNREADABLE_OR_WRONG_PASSWORD');
      expect((error as Error).message).not.toContain('senha-errada-123');
      expect((error as Error).message).not.toContain(PASSPHRASE);
    }
  });

  it('bytes que não são PFX são recusados', () => {
    expect(reasonOf(() => loadA1Certificate(Buffer.from('não é um PFX'), PASSPHRASE))).toBe(
      'UNREADABLE_OR_WRONG_PASSWORD',
    );
  });

  it('PFX cuja chave não corresponde a nenhum certificado é recusado', () => {
    const leaf = pki.issue({ cnpj: CNPJ });
    const stranger = pki.issue({ cnpj: CNPJ });
    const pfx = pki.toPfx(leaf, PASSPHRASE, { includeRoot: false, privateKey: stranger.privateKey });
    expect(reasonOf(() => loadA1Certificate(pfx, PASSPHRASE))).toBe('KEY_CERTIFICATE_MISMATCH');
  });

  it('o certificado carregado assina NF-e que passa na verificação', () => {
    const certificate = loadA1Certificate(pki.toPfx(pki.issue({ cnpj: CNPJ }), PASSPHRASE), PASSPHRASE);
    const signed = signNfeXml(buildUnsignedNfe(makeDocument()).xml, certificate);
    expect(verifyNfeSignature(signed).valid).toBe(true);
  });
});

describe('assertCertificateUsable', () => {
  it('recusa certificado vencido e ainda não válido', () => {
    const expired = loadA1Certificate(
      pki.toPfx(
        pki.issue({ cnpj: CNPJ, notBefore: new Date(Date.now() - 400 * DAY), notAfter: new Date(Date.now() - DAY) }),
        PASSPHRASE,
      ),
      PASSPHRASE,
    );
    const future = loadA1Certificate(
      pki.toPfx(
        pki.issue({ cnpj: CNPJ, notBefore: new Date(Date.now() + DAY), notAfter: new Date(Date.now() + 400 * DAY) }),
        PASSPHRASE,
      ),
      PASSPHRASE,
    );

    expect(reasonOf(() => assertCertificateUsable(expired, { purpose: 'SIGNING' }))).toBe('EXPIRED');
    expect(reasonOf(() => assertCertificateUsable(future, { purpose: 'SIGNING' }))).toBe('NOT_YET_VALID');
  });

  it('assinatura aceita qualquer estabelecimento da empresa e recusa outra empresa', () => {
    const certificate = loadA1Certificate(pki.toPfx(pki.issue({ cnpj: CNPJ }), PASSPHRASE), PASSPHRASE);

    expect(() => assertCertificateUsable(certificate, { purpose: 'SIGNING', issuerCnpj: CNPJ })).not.toThrow();
    expect(() =>
      assertCertificateUsable(certificate, { purpose: 'SIGNING', issuerCnpj: BRANCH_CNPJ }),
    ).not.toThrow();
    expect(
      reasonOf(() => assertCertificateUsable(certificate, { purpose: 'SIGNING', issuerCnpj: OTHER_COMPANY_CNPJ })),
    ).toBe('CNPJ_MISMATCH');
  });

  it('assinatura exige uso da chave para assinatura digital', () => {
    const certificate = loadA1Certificate(
      pki.toPfx(pki.issue({ cnpj: CNPJ, digitalSignature: false }), PASSPHRASE),
      PASSPHRASE,
    );
    expect(reasonOf(() => assertCertificateUsable(certificate, { purpose: 'SIGNING' }))).toBe(
      'MISSING_DIGITAL_SIGNATURE',
    );
  });

  it('transmissão exige a finalidade Autenticação Cliente', () => {
    const serverOnly = loadA1Certificate(
      pki.toPfx(pki.issue({ cnpj: CNPJ, clientAuth: false, serverAuth: true }), PASSPHRASE),
      PASSPHRASE,
    );
    const client = loadA1Certificate(
      pki.toPfx(pki.issue({ cnpj: CNPJ, clientAuth: true }), PASSPHRASE),
      PASSPHRASE,
    );

    expect(reasonOf(() => assertCertificateUsable(serverOnly, { purpose: 'TRANSMISSION' }))).toBe(
      'MISSING_CLIENT_AUTHENTICATION',
    );
    expect(() => assertCertificateUsable(client, { purpose: 'TRANSMISSION' })).not.toThrow();
  });

  it('certificado sem CNPJ não serve para NF-e', () => {
    const certificate = loadA1Certificate(pki.toPfx(pki.issue(), PASSPHRASE), PASSPHRASE);
    expect(certificate.cnpj).toBeUndefined();
    expect(reasonOf(() => assertCertificateUsable(certificate, { purpose: 'TRANSMISSION' }))).toBe('MISSING_CNPJ');
  });
});
