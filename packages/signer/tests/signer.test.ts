import { buildUnsignedNfe } from '@nfe/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeDocument } from '../../core/tests/fixtures/nfe-document.js';
import {
  SIGNATURE_ALGORITHMS,
  XmlSignatureError,
  signNfeXml,
  verifyNfeSignature,
  type SignatureFailureReason,
} from '../src/index.js';
import { createTestCredentials, type TestCredentials } from './support/credentials.js';

let credentials: TestCredentials;
let unsignedXml: string;

beforeAll(() => {
  credentials = createTestCredentials();
  unsignedXml = buildUnsignedNfe(makeDocument()).xml;
});

function failureReason(action: () => unknown): SignatureFailureReason | undefined {
  try {
    action();
  } catch (error) {
    if (error instanceof XmlSignatureError) {
      return error.reason;
    }
    throw error;
  }
  return undefined;
}

describe('signNfeXml', () => {
  it('insere Signature como último filho de NFe, depois de infNFe', () => {
    const signed = signNfeXml(unsignedXml, credentials);
    expect(signed.endsWith('</Signature></NFe>')).toBe(true);
    expect(signed.indexOf('</infNFe>')).toBeLessThan(signed.indexOf('<Signature'));
  });

  it('usa exatamente os algoritmos fixados pelo schema', () => {
    const signed = signNfeXml(unsignedXml, credentials);
    for (const algorithm of Object.values(SIGNATURE_ALGORITHMS)) {
      expect(signed).toContain(`Algorithm="${algorithm}"`);
    }
    expect(signed.match(/<Transform /g)).toHaveLength(2);
  });

  it('referencia o Id de infNFe', () => {
    const { xml, infNFeId } = buildUnsignedNfe(makeDocument());
    expect(signNfeXml(xml, credentials)).toContain(`<Reference URI="#${infNFeId}">`);
  });

  it('não altera o conteúdo fiscal', () => {
    const signed = signNfeXml(unsignedXml, credentials);
    expect(signed.replace(/<Signature[\s\S]*<\/Signature>/, '')).toBe(unsignedXml);
  });

  it('produz assinatura verificável', () => {
    const verification = verifyNfeSignature(signNfeXml(unsignedXml, credentials));
    expect(verification.valid).toBe(true);
  });
});

describe('recusas de assinatura', () => {
  it('documento já assinado', () => {
    const signed = signNfeXml(unsignedXml, credentials);
    expect(failureReason(() => signNfeXml(signed, credentials))).toBe('ALREADY_SIGNED');
  });

  it('certificado vencido', () => {
    const expired = createTestCredentials({
      notBefore: new Date('2020-01-01T00:00:00Z'),
      notAfter: new Date('2021-01-01T00:00:00Z'),
    });
    expect(failureReason(() => signNfeXml(unsignedXml, expired))).toBe('CERTIFICATE_EXPIRED');
  });

  it('certificado ainda não válido', () => {
    const future = createTestCredentials({
      notBefore: new Date('2099-01-01T00:00:00Z'),
      notAfter: new Date('2100-01-01T00:00:00Z'),
    });
    expect(failureReason(() => signNfeXml(unsignedXml, future))).toBe('CERTIFICATE_NOT_YET_VALID');
  });

  it('chave privada que não corresponde ao certificado', () => {
    const other = createTestCredentials();
    const mismatched = { privateKeyPem: other.privateKeyPem, certificatePem: credentials.certificatePem };
    expect(failureReason(() => signNfeXml(unsignedXml, mismatched))).toBe('KEY_CERTIFICATE_MISMATCH');
  });

  it('credencial ilegível, sem vazar material da chave na mensagem', () => {
    const garbage = { privateKeyPem: 'não é PEM', certificatePem: 'também não' };
    expect(failureReason(() => signNfeXml(unsignedXml, garbage))).toBe('INVALID_CREDENTIALS');

    try {
      signNfeXml(unsignedXml, { ...credentials, certificatePem: 'inválido' });
    } catch (error) {
      expect((error as Error).message).not.toContain('PRIVATE KEY');
    }
  });

  it('XML sem infNFe com Id no formato da chave', () => {
    const noId = unsignedXml.replace(/ Id="NFe[0-9A-Z]+"/, ' Id="X"');
    expect(failureReason(() => signNfeXml(noId, credentials))).toBe('DOCUMENT_NOT_SIGNABLE');
  });
});

describe('verifyNfeSignature — detecção de adulteração', () => {
  it('detecta alteração de valor fiscal depois da assinatura', () => {
    const signed = signNfeXml(unsignedXml, credentials);
    const tampered = signed.replace('<vNF>99.80</vNF>', '<vNF>9.80</vNF>');
    expect(tampered).not.toBe(signed);

    const verification = verifyNfeSignature(tampered);
    expect(verification.valid).toBe(false);
    if (!verification.valid) {
      expect(verification.reason).toContain('DigestValue');
    }
  });

  it('detecta SignatureValue adulterado', () => {
    const signed = signNfeXml(unsignedXml, credentials);
    const tampered = signed.replace(
      /<SignatureValue>(.)/,
      (_match, first: string) => `<SignatureValue>${first === 'A' ? 'B' : 'A'}`,
    );
    expect(verifyNfeSignature(tampered).valid).toBe(false);
  });

  it('recusa algoritmo diferente do fixado', () => {
    const signed = signNfeXml(unsignedXml, credentials);
    const downgraded = signed.replace('xmldsig#rsa-sha1', 'xmldsig-more#rsa-sha256');
    expect(verifyNfeSignature(downgraded).valid).toBe(false);
  });
});
