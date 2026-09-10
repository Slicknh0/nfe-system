/**
 * Módulo 11 com suporte a CNPJ alfanumérico.
 *
 * Base normativa: NT 2026.004 (Adequações da NF-e/NFC-e ao CNPJ Alfanumérico) e
 * os tipos do PL_010f_v1.04, onde `TCnpj` passou a ser
 * `xs:string` com pattern `[0-9A-Z]{12}[0-9]{2}` e `TChNFe` com pattern
 * `[0-9]{6}[0-9A-Z]{12}[0-9]{26}`.
 *
 * O valor numérico de cada caractere é `ASCII(c) - 48`. Para os dígitos isso
 * devolve 0..9, o que torna o algoritmo numérico anterior um caso particular
 * deste — chaves e CNPJs puramente numéricos continuam produzindo o mesmo DV.
 */

import { FiscalError } from '../errors.js';

const ASCII_ZERO = 48;
const ASCII_NINE = 57;
const ASCII_UPPER_A = 65;
const ASCII_UPPER_Z = 90;

/** Domínio aceito para caracteres ponderáveis, conforme os patterns do XSD. */
export const ALPHANUMERIC_DOMAIN = /^[0-9A-Z]$/;

export class InvalidCharacterError extends FiscalError {
  constructor(readonly character: string) {
    super(
      `Caractere ${JSON.stringify(character)} fora do domínio [0-9A-Z] exigido ` +
        `pela NT 2026.004. CNPJ alfanumérico deve ser informado em caixa alta.`,
    );
  }
}

/**
 * Converte um caractere no seu valor ponderável.
 *
 * Minúsculas são rejeitadas de propósito: normalizar silenciosamente para caixa
 * alta esconderia dado de cadastro errado e produziria um DV que não bate com o
 * documento que o contribuinte acredita ter emitido.
 */
export function charNumericValue(character: string): number {
  if (character.length !== 1 || !ALPHANUMERIC_DOMAIN.test(character)) {
    throw new InvalidCharacterError(character);
  }

  const code = character.charCodeAt(0);
  const isDigit = code >= ASCII_ZERO && code <= ASCII_NINE;
  const isUpperLetter = code >= ASCII_UPPER_A && code <= ASCII_UPPER_Z;

  if (!isDigit && !isUpperLetter) {
    throw new InvalidCharacterError(character);
  }

  return code - ASCII_ZERO;
}

/**
 * Calcula o dígito verificador módulo 11 de uma base.
 *
 * Pesos cíclicos de 2 a 9 aplicados da direita para a esquerda. Quando o dígito
 * resultante seria 10 ou 11, o DV é zero — regra usada tanto no DV do CNPJ
 * quanto no `cDV` da chave de acesso da NF-e.
 */
export function mod11CheckDigit(base: string): number {
  if (base.length === 0) {
    throw new Error('Base do módulo 11 não pode ser vazia.');
  }

  let sum = 0;
  let weight = 2;

  for (let index = base.length - 1; index >= 0; index -= 1) {
    // `base[index]` é seguro aqui, mas noUncheckedIndexedAccess exige a checagem.
    const character = base[index];
    if (character === undefined) {
      throw new Error('Índice inválido ao percorrer a base do módulo 11.');
    }

    sum += charNumericValue(character) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }

  const checkDigit = 11 - (sum % 11);
  return checkDigit >= 10 ? 0 : checkDigit;
}
