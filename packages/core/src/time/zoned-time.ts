/**
 * Data e hora civis de um instante, no fuso do estabelecimento emitente.
 *
 * `Date` representa um instante absoluto; a NF-e fala em calendário local — AAMM
 * da chave de acesso e `dhEmi` com deslocamento explícito. Derivar isso de UTC
 * produz competência errada perto da virada do mês. O defeito já apareceu uma
 * vez na chave de acesso; a conversão fica centralizada aqui para não reaparecer
 * em `dhEmi`.
 */

import { FiscalError } from '../errors.js';

export class InvalidTimeZoneError extends FiscalError {}

export class InvalidInstantError extends FiscalError {}

export interface ZonedDateTime {
  readonly year: string;
  readonly month: string;
  readonly day: string;
  readonly hour: string;
  readonly minute: string;
  readonly second: string;
  /** Deslocamento em relação a UTC no formato `±HH:MM`. */
  readonly offset: string;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached !== undefined) {
    return cached;
  }

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'longOffset',
    });
  } catch {
    throw new InvalidTimeZoneError(`Fuso horário inválido: ${JSON.stringify(timeZone)}.`);
  }

  formatterCache.set(timeZone, formatter);
  return formatter;
}

/** `longOffset` devolve "GMT" para deslocamento zero e "GMT-03:00" nos demais. */
function normalizeOffset(timeZoneName: string): string {
  if (timeZoneName === 'GMT') {
    return '+00:00';
  }

  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(timeZoneName);
  if (match === null) {
    throw new InvalidTimeZoneError(
      `Deslocamento de fuso não reconhecido: ${JSON.stringify(timeZoneName)}.`,
    );
  }

  const [, sign = '+', hours = '00', minutes = '00'] = match;
  return `${sign}${hours}:${minutes}`;
}

export function toZonedDateTime(instant: Date, timeZone: string): ZonedDateTime {
  if (Number.isNaN(instant.getTime())) {
    throw new InvalidInstantError('Data inválida.');
  }

  const parts = formatterFor(timeZone).formatToParts(instant);
  const pick = (type: Intl.DateTimeFormatPartTypes): string => {
    const value = parts.find((part) => part.type === type)?.value;
    if (value === undefined) {
      throw new InvalidInstantError(`Não foi possível extrair ${type} da data.`);
    }
    return value;
  };

  return {
    year: pick('year').padStart(4, '0'),
    month: pick('month'),
    day: pick('day'),
    hour: pick('hour'),
    minute: pick('minute'),
    second: pick('second'),
    offset: normalizeOffset(pick('timeZoneName')),
  };
}
