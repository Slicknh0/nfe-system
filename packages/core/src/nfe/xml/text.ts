/**
 * Texto livre e campos codificados do documento fiscal.
 *
 * O tipo `TString` do PL_010f_v1.04 é `[!-ÿ]{1}[ -ÿ]{0,}[!-ÿ]{1}|[!-ÿ]{1}`:
 * sem espaço nas bordas e nenhum caractere acima de U+00FF. Travessão (U+2014),
 * aspas tipográficas, `€` e emojis — que chegam naturalmente de copiar e colar —
 * são XML válido, mas violam o leiaute.
 *
 * Política: espaços nas bordas são removidos, porque não carregam significado.
 * Qualquer outro caractere fora do conjunto é recusado com erro que aponta o
 * campo. Trocar "—" por "-" em silêncio alteraria o texto que o contribuinte
 * escreveu no documento fiscal.
 */

import { FiscalError } from '../../errors.js';
import type { CodePattern } from './patterns.js';

export class InvalidFiscalTextError extends FiscalError {
  constructor(
    readonly field: string,
    reason: string,
  ) {
    super(`Campo ${field}: ${reason}`);
  }
}

const LOWEST_ALLOWED_CODE_POINT = 0x20;
const HIGHEST_ALLOWED_CODE_POINT = 0xff;

export function fiscalText(field: string, raw: string): string {
  const value = raw.trim();

  if (value.length === 0) {
    throw new InvalidFiscalTextError(field, 'não pode ser vazio.');
  }

  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < LOWEST_ALLOWED_CODE_POINT || codePoint > HIGHEST_ALLOWED_CODE_POINT) {
      const hex = codePoint.toString(16).toUpperCase().padStart(4, '0');
      throw new InvalidFiscalTextError(
        field,
        `o caractere ${JSON.stringify(character)} (U+${hex}) não é aceito pelo leiaute, que ` +
          `admite apenas U+0020 a U+00FF. Travessões, aspas tipográficas, símbolos como € ` +
          `e emojis precisam ser substituídos.`,
      );
    }
  }

  return value;
}

export function optionalFiscalText(field: string, raw: string | undefined): string | undefined {
  return raw === undefined ? undefined : fiscalText(field, raw);
}

export function codeValue(field: string, value: string, pattern: CodePattern): string {
  if (!pattern.regex.test(value)) {
    throw new InvalidFiscalTextError(
      field,
      `valor ${JSON.stringify(value)} inválido: esperado ${pattern.expected}.`,
    );
  }
  return value;
}

export function optionalCodeValue(
  field: string,
  value: string | undefined,
  pattern: CodePattern,
): string | undefined {
  return value === undefined ? undefined : codeValue(field, value, pattern);
}
