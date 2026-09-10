import { describe, expect, it } from 'vitest';
import { Decimal, DecimalError, RoundingMode, allocate } from '../src/money/decimal.js';

describe('Decimal — aritmética exata', () => {
  it('não sofre o erro clássico de ponto flutuante', () => {
    // 0.1 + 0.2 === 0.30000000000000004 em IEEE-754.
    expect(Decimal.parse('0.1').plus(Decimal.parse('0.2')).toString()).toBe('0.3');
  });

  it('preserva a escala declarada ao formatar', () => {
    expect(Decimal.parse('10').toFixed(2)).toBe('10.00');
    expect(Decimal.parse('1234.5').toFixed(2)).toBe('1234.50');
  });

  it('multiplica quantidade fracionária por preço unitário sem perda', () => {
    const quantity = Decimal.parse('3.7500');
    const unitPrice = Decimal.parse('19.9900');
    expect(quantity.times(unitPrice).toFixed(4)).toBe('74.9625');
  });

  it('soma e subtrai mantendo exatidão em cadeia longa', () => {
    let total = Decimal.ZERO;
    for (let i = 0; i < 100; i += 1) {
      total = total.plus(Decimal.parse('0.01'));
    }
    expect(total.toFixed(2)).toBe('1.00');
  });

  it('compara valores independentemente da escala interna', () => {
    expect(Decimal.parse('1.50').equals(Decimal.parse('1.5'))).toBe(true);
    expect(Decimal.parse('1.50').isGreaterThan(Decimal.parse('1.49'))).toBe(true);
  });

  it('recusa entrada que não é decimal válido em vez de virar NaN', () => {
    expect(() => Decimal.parse('abc')).toThrow(DecimalError);
    expect(() => Decimal.parse('')).toThrow(DecimalError);
    expect(() => Decimal.parse('1.2.3')).toThrow(DecimalError);
  });

  it('aceita valores negativos', () => {
    expect(Decimal.parse('-5.25').plus(Decimal.parse('1.25')).toFixed(2)).toBe('-4.00');
  });
});

describe('Decimal — política de arredondamento explícita', () => {
  it('half-up arredonda 0.5 para cima', () => {
    expect(Decimal.parse('2.345').round(2, RoundingMode.HalfUp).toFixed(2)).toBe('2.35');
    expect(Decimal.parse('2.355').round(2, RoundingMode.HalfUp).toFixed(2)).toBe('2.36');
  });

  it('half-even aproxima do vizinho par no empate', () => {
    expect(Decimal.parse('2.345').round(2, RoundingMode.HalfEven).toFixed(2)).toBe('2.34');
    expect(Decimal.parse('2.355').round(2, RoundingMode.HalfEven).toFixed(2)).toBe('2.36');
  });

  it('arredonda negativos simetricamente em half-up', () => {
    expect(Decimal.parse('-2.345').round(2, RoundingMode.HalfUp).toFixed(2)).toBe('-2.35');
  });
});

describe('allocate — rateio sem centavo perdido', () => {
  it('distribui valor indivisível preservando o total', () => {
    const parts = allocate(Decimal.parse('100.00'), [1, 1, 1], 2);
    expect(parts.map((p) => p.toFixed(2))).toEqual(['33.34', '33.33', '33.33']);

    const sum = parts.reduce((acc, p) => acc.plus(p), Decimal.ZERO);
    expect(sum.toFixed(2)).toBe('100.00');
  });

  it('respeita pesos proporcionais', () => {
    const parts = allocate(Decimal.parse('10.00'), [7, 3], 2);
    expect(parts.map((p) => p.toFixed(2))).toEqual(['7.00', '3.00']);
  });

  it('fecha o total mesmo com pesos que geram dízima', () => {
    const total = Decimal.parse('0.05');
    const parts = allocate(total, [3, 3, 3], 2);
    const sum = parts.reduce((acc, p) => acc.plus(p), Decimal.ZERO);
    expect(sum.toFixed(2)).toBe('0.05');
  });

  it('recusa rateio com peso total zero em vez de dividir por zero', () => {
    expect(() => allocate(Decimal.parse('10.00'), [0, 0], 2)).toThrow(DecimalError);
  });

  it('recusa peso negativo', () => {
    expect(() => allocate(Decimal.parse('10.00'), [-1, 2], 2)).toThrow(DecimalError);
  });
});
