import { describe, expect, it } from 'vitest';
import { Decimal } from '../src/money/decimal.js';
import {
  XmlValueFormatError,
  formatDateTime,
  formatMonetaryValue,
  formatPercentage,
  formatQuantity,
  formatUnitValue,
} from '../src/nfe/xml/format.js';
import { InvalidTimeZoneError } from '../src/time/zoned-time.js';
import { officialSimpleTypePattern } from './support/official-xsd.js';

const d = (value: string): Decimal => Decimal.parse(value);

describe('valores monetários — TDec_1302', () => {
  const pattern = officialSimpleTypePattern('TDec_1302');

  it('formata com duas casas e casa com o pattern oficial', () => {
    for (const [input, expected] of [
      ['0', '0.00'],
      ['1234.5', '1234.50'],
      ['99.80', '99.80'],
    ] as const) {
      const formatted = formatMonetaryValue('vProd', d(input));
      expect(formatted).toBe(expected);
      expect(formatted).toMatch(pattern);
    }
  });

  it('recusa negativo', () => {
    expect(() => formatMonetaryValue('vProd', d('-1.00'))).toThrow(XmlValueFormatError);
  });

  it('recusa valor com mais casas em vez de arredondar em silêncio', () => {
    expect(() => formatMonetaryValue('vProd', d('1.005'))).toThrow(XmlValueFormatError);
  });
});

describe('quantidade e valor unitário', () => {
  it('quantidade com 4 casas casa com TDec_1104v', () => {
    const formatted = formatQuantity('qCom', d('3.75'));
    expect(formatted).toBe('3.7500');
    expect(formatted).toMatch(officialSimpleTypePattern('TDec_1104v'));
  });

  it('valor unitário com 10 casas casa com TDec_1110v', () => {
    const formatted = formatUnitValue('vUnCom', d('19.99'));
    expect(formatted).toBe('19.9900000000');
    expect(formatted).toMatch(officialSimpleTypePattern('TDec_1110v'));
  });

  it('recusa quantidade com mais de 4 casas', () => {
    expect(() => formatQuantity('qCom', d('1.00001'))).toThrow(XmlValueFormatError);
  });

  it('percentual com 4 casas', () => {
    expect(formatPercentage('pPIS', d('1.65'))).toBe('1.6500');
  });
});

describe('data e hora — TDateTimeUTC', () => {
  const pattern = officialSimpleTypePattern('TDateTimeUTC');

  it('usa o deslocamento do fuso do emitente e casa com o pattern oficial', () => {
    const formatted = formatDateTime('dhEmi', new Date('2026-09-11T13:00:00Z'), 'America/Sao_Paulo');
    expect(formatted).toBe('2026-09-11T10:00:00-03:00');
    expect(formatted).toMatch(pattern);
  });

  it('representa UTC como +00:00', () => {
    const formatted = formatDateTime('dhEmi', new Date('2026-09-11T13:00:00Z'), 'UTC');
    expect(formatted).toBe('2026-09-11T13:00:00+00:00');
    expect(formatted).toMatch(pattern);
  });

  it('mantém a data local na virada do mês', () => {
    // 01/02 02:30 UTC ainda é 31/01 em Brasília.
    const formatted = formatDateTime('dhEmi', new Date('2026-02-01T02:30:00Z'), 'America/Sao_Paulo');
    expect(formatted).toBe('2026-01-31T23:30:00-03:00');
  });

  it('recusa fuso com minutos no deslocamento, que o tipo não admite', () => {
    expect(() =>
      formatDateTime('dhEmi', new Date('2026-09-11T13:00:00Z'), 'Asia/Kolkata'),
    ).toThrow(XmlValueFormatError);
  });

  it('recusa fuso inexistente', () => {
    expect(() =>
      formatDateTime('dhEmi', new Date('2026-09-11T13:00:00Z'), 'Mars/Olympus'),
    ).toThrow(InvalidTimeZoneError);
  });
});
