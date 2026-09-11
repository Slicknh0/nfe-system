import { describe, expect, it } from 'vitest';
import { isFiscalError } from '../src/errors.js';
import {
  InvalidCpfError,
  assertValidCpf,
  calculateCpfCheckDigits,
  isValidCpf,
} from '../src/fiscal/cpf.js';
import { isValidGtin } from '../src/fiscal/gtin.js';

describe('CPF', () => {
  it('valida CPF com dígitos verificadores corretos', () => {
    expect(isValidCpf('52998224725')).toBe(true);
    expect(isValidCpf('529.982.247-25')).toBe(true);
  });

  it('calcula os dígitos verificadores', () => {
    // DV1: soma ponderada 295; 2950 % 11 = 2. DV2: soma 347; 3470 % 11 = 5.
    expect(calculateCpfCheckDigits('529982247')).toBe('25');
  });

  it('rejeita DV adulterado', () => {
    expect(isValidCpf('52998224724')).toBe(false);
  });

  it('rejeita sequência de dígito único', () => {
    expect(isValidCpf('11111111111')).toBe(false);
  });

  it('assertValidCpf lança erro fiscal tipado', () => {
    try {
      assertValidCpf('52998224724');
      throw new Error('deveria ter lançado');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidCpfError);
      expect(isFiscalError(error)).toBe(true);
    }
  });
});

describe('GTIN — algoritmo GS1', () => {
  it('valida GTIN-13 conhecido', () => {
    expect(isValidGtin('4006381333931')).toBe(true);
  });

  it('valida GTIN-8 conhecido', () => {
    expect(isValidGtin('96385074')).toBe(true);
  });

  it('rejeita dígito verificador errado', () => {
    expect(isValidGtin('4006381333932')).toBe(false);
  });

  it('rejeita tamanho fora do leiaute', () => {
    expect(isValidGtin('12345')).toBe(false);
  });

  it('não trata o literal SEM GTIN como código', () => {
    expect(isValidGtin('SEM GTIN')).toBe(false);
  });
});
