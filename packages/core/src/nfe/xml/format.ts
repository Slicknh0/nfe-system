/**
 * Formatação de valores para os tipos numéricos e de data do leiaute.
 *
 * | Função                | Tipo XSD       | Casas |
 * |-----------------------|----------------|-------|
 * | `formatMonetaryValue` | `TDec_1302`    | 2     |
 * | `formatQuantity`      | `TDec_1104v`   | 4     |
 * | `formatUnitValue`     | `TDec_1110v`   | 10    |
 * | `formatPercentage`    | `TDec_0302a04` | 4     |
 * | `formatDateTime`      | `TDateTimeUTC` | —     |
 *
 * Serializar não arredonda. Um valor com mais casas do que o campo admite é
 * recusado: arredondar aqui esconderia um cálculo feito na escala errada, e o
 * valor impresso deixaria de ser o valor calculado.
 */

import { FiscalError } from '../../errors.js';
import { RoundingMode, type Decimal } from '../../money/decimal.js';
import { toZonedDateTime } from '../../time/zoned-time.js';

export class XmlValueFormatError extends FiscalError {
  constructor(
    readonly field: string,
    reason: string,
  ) {
    super(`Campo ${field}: ${reason}`);
  }
}

function formatFixedScale(field: string, value: Decimal, scale: number): string {
  if (value.isNegative()) {
    throw new XmlValueFormatError(
      field,
      `valor negativo (${value.toString()}) não é aceito pelo leiaute.`,
    );
  }

  if (!value.round(scale, RoundingMode.Truncate).equals(value)) {
    throw new XmlValueFormatError(
      field,
      `valor ${value.toString()} tem mais de ${scale} casas decimais. ` +
        `O arredondamento precisa acontecer no cálculo, não na serialização.`,
    );
  }

  return value.toFixed(scale);
}

export function formatMonetaryValue(field: string, value: Decimal): string {
  return formatFixedScale(field, value, 2);
}

export function formatQuantity(field: string, value: Decimal): string {
  return formatFixedScale(field, value, 4);
}

export function formatUnitValue(field: string, value: Decimal): string {
  return formatFixedScale(field, value, 10);
}

export function formatPercentage(field: string, value: Decimal): string {
  return formatFixedScale(field, value, 4);
}

/** `TDateTimeUTC` só aceita deslocamentos em horas cheias, de -11:00 a +12:00. */
const ACCEPTED_OFFSET = /^(?:[+-](?:0[0-9]|1[01]):00|\+12:00)$/;

export function formatDateTime(field: string, instant: Date, timeZone: string): string {
  const zoned = toZonedDateTime(instant, timeZone);

  if (!ACCEPTED_OFFSET.test(zoned.offset)) {
    throw new XmlValueFormatError(
      field,
      `o deslocamento ${zoned.offset} do fuso ${timeZone} não é aceito pelo tipo ` +
        `TDateTimeUTC, que exige horas cheias entre -11:00 e +12:00.`,
    );
  }

  return (
    `${zoned.year}-${zoned.month}-${zoned.day}` +
    `T${zoned.hour}:${zoned.minute}:${zoned.second}${zoned.offset}`
  );
}
