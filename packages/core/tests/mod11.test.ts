import { describe, expect, it } from 'vitest';
import { charNumericValue, mod11CheckDigit } from '../src/fiscal/mod11.js';

/**
 * Base normativa: NT 2026.004 (CNPJ alfanumérico).
 * O valor numérico de cada caractere é ASCII(c) - 48, de modo que os dígitos
 * '0'..'9' continuam valendo 0..9 e as letras 'A'..'Z' passam a valer 17..42.
 */
describe('charNumericValue — conversão ASCII-48 da NT 2026.004', () => {
  it('mantém dígitos compatíveis com o algoritmo numérico anterior', () => {
    expect(charNumericValue('0')).toBe(0);
    expect(charNumericValue('9')).toBe(9);
  });

  it('converte letras maiúsculas somando o deslocamento ASCII', () => {
    // 'A' = 65 na tabela ASCII; 65 - 48 = 17.
    expect(charNumericValue('A')).toBe(17);
    // 'Z' = 90 na tabela ASCII; 90 - 48 = 42.
    expect(charNumericValue('Z')).toBe(42);
  });

  it('rejeita minúsculas — a NT exige CNPJ em caixa alta', () => {
    expect(() => charNumericValue('a')).toThrow();
  });

  it('rejeita caracteres fora do domínio [0-9A-Z]', () => {
    expect(() => charNumericValue('/')).toThrow();
    expect(() => charNumericValue('-')).toThrow();
  });
});

describe('mod11CheckDigit — pesos cíclicos 2..9 da direita para a esquerda', () => {
  it('calcula o primeiro DV do CNPJ conhecido 11222333/0001-81', () => {
    // Soma ponderada = 102; 102 % 11 = 3; DV = 11 - 3 = 8.
    expect(mod11CheckDigit('112223330001')).toBe(8);
  });

  it('calcula o segundo DV do mesmo CNPJ conhecido', () => {
    // Soma ponderada = 120; 120 % 11 = 10; DV = 11 - 10 = 1.
    expect(mod11CheckDigit('1122233300018')).toBe(1);
  });

  it('devolve 0 quando o resto produz DV maior ou igual a 10', () => {
    // Regra da NF-e: resto 0 ou 1 resulta em DV zero.
    expect(mod11CheckDigit('0'.repeat(12))).toBe(0);
  });
});
