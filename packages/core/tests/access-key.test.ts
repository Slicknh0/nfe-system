import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AccessKeyValidationError,
  buildAccessKey,
  isValidAccessKey,
  parseAccessKey,
  type AccessKeyInput,
} from '../src/fiscal/access-key.js';

/**
 * O pattern não é copiado para dentro do teste: ele é extraído do XSD oficial
 * versionado em `schemas/nfe/PL_010f_v1.04/`. Se um pacote de liberação futuro
 * mudar a estrutura da chave, este teste passa a falhar em vez de continuar
 * verde contra uma regra revogada.
 */
function officialAccessKeyPattern(): RegExp {
  const xsdPath = fileURLToPath(
    new URL('../../../schemas/nfe/PL_010f_v1.04/tiposBasico_v4.00.xsd', import.meta.url),
  );
  const xsd = readFileSync(xsdPath, 'utf8');

  const typeBlock = /<xs:simpleType name="TChNFe">[\s\S]*?<\/xs:simpleType>/.exec(xsd);
  if (typeBlock === null) {
    throw new Error('Tipo TChNFe não encontrado no XSD oficial.');
  }

  const pattern = /pattern value="([^"]+)"/.exec(typeBlock[0]);
  if (pattern?.[1] === undefined) {
    throw new Error('Pattern de TChNFe não encontrado no XSD oficial.');
  }

  return new RegExp(`^${pattern[1]}$`);
}

const numericIssuer: AccessKeyInput = {
  cUF: 35, // São Paulo
  issueDate: new Date(Date.UTC(2026, 8, 10, 12, 0, 0)), // 2026-09
  cnpj: '11222333000181',
  model: 55,
  series: 1,
  number: 1234,
  tpEmis: 1,
  cNF: '12345678',
};

describe('buildAccessKey — conformidade com o XSD oficial', () => {
  it('produz uma chave de 44 caracteres', () => {
    expect(buildAccessKey(numericIssuer)).toHaveLength(44);
  });

  it('casa com o pattern TChNFe extraído do PL_010f_v1.04', () => {
    expect(buildAccessKey(numericIssuer)).toMatch(officialAccessKeyPattern());
  });

  it('aceita CNPJ alfanumérico e ainda casa com o pattern oficial', () => {
    // Posições 7-18 da chave admitem [0-9A-Z]; o DV do CNPJ segue numérico.
    const key = buildAccessKey({ ...numericIssuer, cnpj: 'A1B2C3D4E5F601' });
    expect(key).toMatch(officialAccessKeyPattern());
    expect(key.slice(6, 18)).toBe('A1B2C3D4E5F6');
  });

  it('posiciona cada campo exatamente onde o leiaute manda', () => {
    const key = buildAccessKey(numericIssuer);
    expect(key.slice(0, 2)).toBe('35'); // cUF
    expect(key.slice(2, 6)).toBe('2609'); // AAMM
    expect(key.slice(6, 20)).toBe('11222333000181'); // CNPJ
    expect(key.slice(20, 22)).toBe('55'); // modelo
    expect(key.slice(22, 25)).toBe('001'); // série
    expect(key.slice(25, 34)).toBe('000001234'); // nNF
    expect(key.slice(34, 35)).toBe('1'); // tpEmis
    expect(key.slice(35, 43)).toBe('12345678'); // cNF
  });
});

describe('parseAccessKey — round-trip', () => {
  it('reconstrói os campos da chave gerada', () => {
    const key = buildAccessKey(numericIssuer);
    const parsed = parseAccessKey(key);

    expect(parsed.cUF).toBe(35);
    expect(parsed.cnpj).toBe('11222333000181');
    expect(parsed.model).toBe(55);
    expect(parsed.series).toBe(1);
    expect(parsed.number).toBe(1234);
    expect(parsed.checkDigit).toBe(Number(key[43]));
  });
});

describe('isValidAccessKey — detecção de adulteração', () => {
  it('aceita a própria chave gerada', () => {
    expect(isValidAccessKey(buildAccessKey(numericIssuer))).toBe(true);
  });

  it('rejeita chave com um dígito trocado no número da nota', () => {
    const key = buildAccessKey(numericIssuer);
    const tampered = `${key.slice(0, 33)}${key[33] === '9' ? '8' : '9'}${key.slice(34)}`;
    expect(isValidAccessKey(tampered)).toBe(false);
  });

  it('rejeita chave com comprimento diferente de 44', () => {
    expect(isValidAccessKey('123')).toBe(false);
  });

  it('rejeita CNPJ em minúsculas em vez de normalizar por conta própria', () => {
    expect(() => buildAccessKey({ ...numericIssuer, cnpj: 'a1b2c3d4e5f601' })).toThrow(
      AccessKeyValidationError,
    );
  });
});

describe('buildAccessKey — validação de entrada', () => {
  it('recusa número de nota fora da faixa do leiaute', () => {
    expect(() => buildAccessKey({ ...numericIssuer, number: 1_000_000_000 })).toThrow(
      AccessKeyValidationError,
    );
  });

  it('recusa cNF com tamanho diferente de 8', () => {
    expect(() => buildAccessKey({ ...numericIssuer, cNF: '123' })).toThrow(
      AccessKeyValidationError,
    );
  });

  it('recusa CNPJ com tamanho diferente de 14', () => {
    expect(() => buildAccessKey({ ...numericIssuer, cnpj: '1122233300018' })).toThrow(
      AccessKeyValidationError,
    );
  });
});
