import { describe, expect, it } from 'vitest';
import { POSTAL_CODE } from '../src/nfe/xml/patterns.js';
import {
  InvalidFiscalTextError,
  codeValue,
  fiscalText,
  optionalFiscalText,
} from '../src/nfe/xml/text.js';
import { officialSimpleTypePattern } from './support/official-xsd.js';

const TSTRING = officialSimpleTypePattern('TString');

describe('fiscalText — tipo TString do leiaute', () => {
  it('remove espaços das bordas e o resultado casa com o pattern oficial', () => {
    const value = fiscalText('xNome', '  Maria da Silva  ');
    expect(value).toBe('Maria da Silva');
    expect(value).toMatch(TSTRING);
  });

  it('aceita acentuação do Latin-1', () => {
    const value = fiscalText('xMun', 'São João da Boa Vista');
    expect(value).toMatch(TSTRING);
  });

  it('recusa travessão tipográfico apontando o campo', () => {
    expect(() => fiscalText('ide/natOp', 'Venda — varejo')).toThrow(InvalidFiscalTextError);
    expect(() => fiscalText('ide/natOp', 'Venda — varejo')).toThrow(/ide\/natOp/);
  });

  it('recusa emoji', () => {
    expect(() => fiscalText('xProd', 'Camiseta 😀')).toThrow(InvalidFiscalTextError);
  });

  it('recusa quebra de linha interna', () => {
    expect(() => fiscalText('infCpl', 'linha 1\nlinha 2')).toThrow(InvalidFiscalTextError);
  });

  it('recusa texto vazio depois de remover espaços', () => {
    expect(() => fiscalText('xNome', '   ')).toThrow(InvalidFiscalTextError);
  });

  it('mantém ausência como ausência', () => {
    expect(optionalFiscalText('xCpl', undefined)).toBeUndefined();
  });
});

describe('codeValue', () => {
  it('aceita valor no formato', () => {
    expect(codeValue('CEP', '01310100', POSTAL_CODE)).toBe('01310100');
  });

  it('recusa valor com máscara em vez de removê-la em silêncio', () => {
    expect(() => codeValue('CEP', '01310-100', POSTAL_CODE)).toThrow(InvalidFiscalTextError);
  });
});
