/**
 * Pedido de inutilização: montar → assinar → XSD oficial (PL_010d_v1.03) →
 * verificação própria e independente.
 */

import { fileURLToPath } from 'node:url';
import { Environment, buildUnsignedInutilization, buildUnsignedNfe } from '@nfe/core';
import { NfeSchemaValidator, PL_010D_INUTILIZATION } from '@nfe/xsd';
import { SignedXml } from 'xml-crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeDocument } from '../../core/tests/fixtures/nfe-document.js';
import {
  XmlSignatureError,
  signInutilizationXml,
  signNfeXml,
  verifyInutilizationSignature,
} from '../src/index.js';
import { createTestCredentials, type TestCredentials } from './support/credentials.js';

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
const validator = new NfeSchemaValidator(repositoryRoot);
let credentials: TestCredentials;

beforeAll(() => {
  credentials = createTestCredentials();
});

afterAll(() => validator.dispose());

const unsigned = () =>
  buildUnsignedInutilization({
    environment: Environment.Homologation,
    stateCode: 35,
    year: 2026,
    cnpj: '11222333000181',
    series: 1,
    firstNumber: 7,
    lastNumber: 7,
    justification: 'Numeracao nao utilizada: NF-e pendente de retorno nao localizada',
  });

function reasonOf(action: () => unknown): string | undefined {
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

describe('pedido de inutilização', () => {
  it('sem assinatura é recusado pelo XSD oficial', () => {
    const result = validator.validate(unsigned().xml, PL_010D_INUTILIZATION);
    expect(result.valid).toBe(false);
    expect(result.errors.map((error) => error.technicalMessage).join('\n')).toContain('Signature');
  });

  it('assinado, passa no XSD oficial do PL_010d_v1.03', () => {
    const signed = signInutilizationXml(unsigned().xml, credentials);
    expect(validator.validate(signed, PL_010D_INUTILIZATION).errors).toEqual([]);
  });

  it('a assinatura cobre infInut e confere na verificação própria e na independente', () => {
    const { xml, id } = unsigned();
    const signed = signInutilizationXml(xml, credentials);

    expect(signed).toContain(`<Reference URI="#${id}">`);
    expect(verifyInutilizationSignature(signed).valid).toBe(true);

    const verifier = new SignedXml({ publicCert: credentials.certificatePem });
    verifier.loadSignature(/<Signature[\s\S]*<\/Signature>/.exec(signed)![0]);
    expect(verifier.checkSignature(signed)).toBe(true);
  });

  it('faixa alterada depois da assinatura é detectada', () => {
    const signed = signInutilizationXml(unsigned().xml, credentials);
    const tampered = signed.replace('<nNFFin>7</nNFFin>', '<nNFFin>70</nNFFin>');
    const verification = verifyInutilizationSignature(tampered);
    expect(verification.valid).toBe(false);
  });

  it('cada assinador recusa o documento do outro', () => {
    expect(reasonOf(() => signNfeXml(unsigned().xml, credentials))).toBe('DOCUMENT_NOT_SIGNABLE');
    expect(reasonOf(() => signInutilizationXml(buildUnsignedNfe(makeDocument()).xml, credentials))).toBe(
      'DOCUMENT_NOT_SIGNABLE',
    );
  });
});
