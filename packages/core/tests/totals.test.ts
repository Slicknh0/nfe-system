import { describe, expect, it } from 'vitest';
import { InvalidNfeDocumentError } from '../src/nfe/document.js';
import { computeTotals, itemGrossValue } from '../src/nfe/totals.js';
import { d, makeItem } from './fixtures/nfe-document.js';

describe('itemGrossValue — vProd = qCom × vUnCom', () => {
  it('arredonda para duas casas em HalfUp', () => {
    // 3,75 × 19,99 = 74,9625
    expect(itemGrossValue({ quantity: d('3.7500'), unitPrice: d('19.9900') }).toFixed(2)).toBe(
      '74.96',
    );
  });

  it('arredonda o empate para cima', () => {
    expect(itemGrossValue({ quantity: d('1'), unitPrice: d('0.125') }).toFixed(2)).toBe('0.13');
  });

  it('não arredonda duas vezes quando o produto excede a escala interna', () => {
    // 0,0001 × 49,9999999999 = 0,00499999999999 (14 casas). O correto em duas
    // casas é 0,00. Arredondar primeiro para 10 casas daria 0,0050000000 e, em
    // seguida, 0,01.
    expect(
      itemGrossValue({ quantity: d('0.0001'), unitPrice: d('49.9999999999') }).toFixed(2),
    ).toBe('0.00');
  });
});

describe('computeTotals', () => {
  it('soma valores dos itens e aplica a fórmula de vNF', () => {
    const totals = computeTotals([
      makeItem({ quantity: d('1'), unitPrice: d('100.00'), discount: d('10.00'), freight: d('5.00') }),
      makeItem({ quantity: d('1'), unitPrice: d('50.00'), insurance: d('2.00'), otherExpenses: d('1.00') }),
    ]);

    expect(totals.products.toFixed(2)).toBe('150.00');
    expect(totals.discount.toFixed(2)).toBe('10.00');
    expect(totals.freight.toFixed(2)).toBe('5.00');
    expect(totals.insurance.toFixed(2)).toBe('2.00');
    expect(totals.otherExpenses.toFixed(2)).toBe('1.00');
    // vNF = vProd − vDesc + vFrete + vSeg + vOutro
    expect(totals.invoice.toFixed(2)).toBe('148.00');
  });

  it('acumula PIS e COFINS sem que entrem no vNF', () => {
    const totals = computeTotals([
      makeItem({
        quantity: d('1'),
        unitPrice: d('100.00'),
        taxes: {
          icms: { kind: 'SimplesNacional102', origin: 0, csosn: '102' },
          pis: { kind: 'Rate', cst: '01', base: d('100.00'), rate: d('0.65'), amount: d('0.65') },
          cofins: { kind: 'Rate', cst: '01', base: d('100.00'), rate: d('3.00'), amount: d('3.00') },
        },
      }),
    ]);

    expect(totals.pis.toFixed(2)).toBe('0.65');
    expect(totals.cofins.toFixed(2)).toBe('3.00');
    expect(totals.invoice.toFixed(2)).toBe('100.00');
  });

  it('mantém ICMS zerado no grupo ICMSSN102', () => {
    const totals = computeTotals([makeItem()]);
    expect(totals.icmsBase.isZero()).toBe(true);
    expect(totals.icmsAmount.isZero()).toBe(true);
  });

  it('recusa nota sem itens', () => {
    expect(() => computeTotals([])).toThrow(InvalidNfeDocumentError);
  });

  it('recusa total negativo', () => {
    expect(() =>
      computeTotals([makeItem({ quantity: d('1'), unitPrice: d('10.00'), discount: d('20.00') })]),
    ).toThrow(InvalidNfeDocumentError);
  });
});
