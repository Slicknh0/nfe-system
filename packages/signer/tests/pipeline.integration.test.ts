/**
 * Pipeline completo contra as regras oficiais: montar → assinar → validar no XSD
 * do PL_010f_v1.04 → verificar a assinatura com implementação independente.
 *
 * É o teste que prova que o XML produzido é aceito pelo leiaute oficial, e não
 * apenas pelos testes que o próprio sistema escreveu.
 */

import { fileURLToPath } from 'node:url';
import {
  EmissionType,
  StateRegistrationIndicator,
  buildUnsignedNfe,
  calculateCnpjCheckDigits,
  type NfeDocument,
} from '@nfe/core';
import { NfeSchemaValidator } from '@nfe/xsd';
import { SignedXml } from 'xml-crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { d, makeDocument, makeItem } from '../../core/tests/fixtures/nfe-document.js';
import { signNfeXml, verifyNfeSignature } from '../src/index.js';
import { createTestCredentials, type TestCredentials } from './support/credentials.js';

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
const validator = new NfeSchemaValidator(repositoryRoot);
let credentials: TestCredentials;

beforeAll(() => {
  credentials = createTestCredentials();
});

afterAll(() => validator.dispose());

/** Verificação por implementação de XML-DSig independente da deste sistema. */
function verifyWithXmlCrypto(signedXml: string): boolean {
  const signatureXml = /<Signature[\s\S]*<\/Signature>/.exec(signedXml)?.[0];
  if (signatureXml === undefined) {
    return false;
  }
  const verifier = new SignedXml({ publicCert: credentials.certificatePem });
  verifier.loadSignature(signatureXml);
  try {
    return verifier.checkSignature(signedXml);
  } catch {
    return false;
  }
}

function technicalErrors(xml: string): string[] {
  return validator.validate(xml).errors.map((error) => error.technicalMessage);
}

const alphanumericCnpj = (base: string): string => `${base}${calculateCnpjCheckDigits(base)}`;

const scenarios: ReadonlyArray<readonly [string, () => NfeDocument]> = [
  ['documento de referência: SP, Simples Nacional, consumidor pessoa física', () => makeDocument()],
  [
    'destinatário contribuinte com CNPJ alfanumérico e inscrição estadual',
    () => {
      const base = makeDocument();
      return {
        ...base,
        recipient: {
          ...base.recipient,
          document: { type: 'CNPJ', value: alphanumericCnpj('B2C3D4E5F6G7') },
          name: 'Distribuidora Exemplo Ltda',
          stateRegistrationIndicator: StateRegistrationIndicator.Contributor,
          stateRegistration: '987654321098',
        },
      };
    },
  ],
  [
    'emitente com CNPJ alfanumérico',
    () => {
      const base = makeDocument();
      return { ...base, issuer: { ...base.issuer, cnpj: alphanumericCnpj('A1B2C3D4E5F6') } };
    },
  ],
  [
    'vários itens com desconto, frete, seguro, GTIN, CEST e PIS/COFINS por alíquota e não tributado',
    () =>
      makeDocument({
        items: [
          makeItem({ gtin: '4006381333931', cest: '2806300', discount: d('5.00'), freight: d('3.50') }),
          makeItem({
            productCode: 'CAL-010',
            description: 'Calça jeans',
            quantity: d('1.5'),
            unitPrice: d('129.9990'),
            insurance: d('1.20'),
            otherExpenses: d('0.30'),
            taxes: {
              icms: { kind: 'SimplesNacional102', origin: 0, csosn: '400' },
              pis: { kind: 'Rate', cst: '01', base: d('195.00'), rate: d('0.65'), amount: d('1.27') },
              cofins: { kind: 'NonTaxed', cst: '07' },
            },
          }),
        ],
        payment: { entries: [{ method: '03', amount: d('294.80') }, { method: '01', amount: d('0.50') }] },
        additionalInformation: {
          complementary: 'Documento emitido por ME ou EPP optante pelo Simples Nacional',
        },
        technicalResponsible: {
          cnpj: '11222333000181',
          contactName: 'Equipe Fiscal',
          email: 'fiscal@example.com',
          phone: '1133334444',
        },
      }),
  ],
  [
    'contingência SVC-AN',
    () => {
      const base = makeDocument();
      return {
        ...base,
        identification: {
          ...base.identification,
          emissionType: EmissionType.SvcAn,
          contingency: {
            enteredAt: new Date('2026-09-11T10:00:00-03:00'),
            justification: 'Indisponibilidade da SEFAZ autorizadora de SP',
          },
        },
      };
    },
  ],
];

describe('XML sem assinatura', () => {
  it('é rejeitado pelo XSD porque ds:Signature é obrigatória', () => {
    const errors = technicalErrors(buildUnsignedNfe(makeDocument()).xml);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join('\n')).toContain('Signature');
  });
});

describe.each(scenarios)('pipeline oficial — %s', (_label, scenario) => {
  it('montado e assinado, passa na validação contra o XSD oficial', () => {
    const signed = signNfeXml(buildUnsignedNfe(scenario()).xml, credentials);
    expect(technicalErrors(signed)).toEqual([]);
  });

  it('assinatura confere na verificação própria e na independente', () => {
    const signed = signNfeXml(buildUnsignedNfe(scenario()).xml, credentials);
    expect(verifyNfeSignature(signed).valid).toBe(true);
    expect(verifyWithXmlCrypto(signed)).toBe(true);
  });
});

describe('verificação independente detecta adulteração', () => {
  it('xml-crypto recusa documento com valor alterado', () => {
    const signed = signNfeXml(buildUnsignedNfe(makeDocument()).xml, credentials);
    const tampered = signed.replace('<vNF>99.80</vNF>', '<vNF>9.80</vNF>');
    expect(verifyWithXmlCrypto(tampered)).toBe(false);
  });
});
