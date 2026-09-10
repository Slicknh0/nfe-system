import { describe, expect, it } from 'vitest';
import {
  InvalidCnpjError,
  assertValidCnpj,
  calculateCnpjCheckDigits,
  formatCnpj,
  isValidCnpj,
  normalizeCnpj,
} from '../src/fiscal/cnpj.js';
import { isFiscalError } from '../src/errors.js';

describe('CNPJ numérico — compatibilidade com o algoritmo anterior', () => {
  it('valida CNPJ conhecido', () => {
    expect(isValidCnpj('11222333000181')).toBe(true);
  });

  it('calcula os DVs do CNPJ conhecido', () => {
    expect(calculateCnpjCheckDigits('112223330001')).toBe('81');
  });

  it('rejeita DV adulterado', () => {
    expect(isValidCnpj('11222333000182')).toBe(false);
  });

  it('aceita CNPJ com máscara', () => {
    expect(isValidCnpj('11.222.333/0001-81')).toBe(true);
  });

  it('rejeita sequência de caractere único', () => {
    expect(isValidCnpj('00000000000000')).toBe(false);
    expect(isValidCnpj('11111111111111')).toBe(false);
  });
});

describe('CNPJ alfanumérico — NT 2026.004', () => {
  it('aceita base alfanumérica com DV calculado pela regra ASCII-48', () => {
    const base = 'A1B2C3D4E5F6';
    const cnpj = `${base}${calculateCnpjCheckDigits(base)}`;
    expect(isValidCnpj(cnpj)).toBe(true);
  });

  it('detecta adulteração em posição alfanumérica', () => {
    const base = 'A1B2C3D4E5F6';
    const cnpj = `${base}${calculateCnpjCheckDigits(base)}`;
    const tampered = `B${cnpj.slice(1)}`;
    expect(isValidCnpj(tampered)).toBe(false);
  });

  it('normaliza minúsculas na fronteira de entrada', () => {
    const base = 'A1B2C3D4E5F6';
    const cnpj = `${base}${calculateCnpjCheckDigits(base)}`;
    expect(normalizeCnpj(cnpj.toLowerCase())).toBe(cnpj);
    expect(isValidCnpj(cnpj.toLowerCase())).toBe(true);
  });

  it('recusa letra nas posições de dígito verificador', () => {
    // O pattern oficial mantém os dois últimos como [0-9].
    expect(isValidCnpj('A1B2C3D4E5F6AB')).toBe(false);
  });
});

describe('assertValidCnpj', () => {
  it('devolve a forma canônica', () => {
    expect(assertValidCnpj('11.222.333/0001-81')).toBe('11222333000181');
  });

  it('lança erro tipado classificado como fiscal', () => {
    try {
      assertValidCnpj('11222333000182');
      throw new Error('deveria ter lançado');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidCnpjError);
      // Erro fiscal: repetir sem corrigir o dado dá o mesmo resultado.
      expect(isFiscalError(error)).toBe(true);
      expect((error as InvalidCnpjError).retryable).toBe(false);
    }
  });

  it('rejeita tamanho inválido', () => {
    expect(() => assertValidCnpj('1122233300018')).toThrow(InvalidCnpjError);
  });
});

describe('formatCnpj', () => {
  it('aplica a máscara de exibição', () => {
    expect(formatCnpj('11222333000181')).toBe('11.222.333/0001-81');
  });

  it('devolve a entrada intacta quando o tamanho não bate', () => {
    expect(formatCnpj('123')).toBe('123');
  });
});
