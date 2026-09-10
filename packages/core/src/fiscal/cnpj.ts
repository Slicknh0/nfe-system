/**
 * CNPJ alfanumérico.
 *
 * Base normativa: NT 2026.004 e o tipo `TCnpj` do PL_010f_v1.04, que passou a
 * ser `xs:string` com pattern `[0-9A-Z]{12}[0-9]{2}` — doze posições
 * alfanuméricas de raiz e ordem, seguidas de dois dígitos verificadores que
 * permanecem numéricos.
 *
 * O DV usa o mesmo módulo 11 da chave de acesso, com o valor de cada caractere
 * dado por `ASCII(c) - 48`. Para um CNPJ puramente numérico o resultado é
 * idêntico ao algoritmo anterior, então cadastros existentes seguem válidos.
 */

import { FiscalError } from '../errors.js';
import { mod11CheckDigit } from './mod11.js';

export const CNPJ_LENGTH = 14;
export const CNPJ_BASE_LENGTH = 12;

const CNPJ_PATTERN = /^[0-9A-Z]{12}[0-9]{2}$/;
const PUNCTUATION = /[.\-/\s]/g;

export class InvalidCnpjError extends FiscalError {
  constructor(
    readonly value: string,
    reason: string,
  ) {
    super(`CNPJ ${JSON.stringify(value)} inválido: ${reason}`);
  }
}

/**
 * Remove pontuação de máscara e normaliza para caixa alta.
 *
 * A normalização acontece só aqui, na fronteira de entrada. A partir daí o
 * domínio trabalha com o valor canônico — normalizar no meio do cálculo do DV
 * mascararia cadastro errado.
 */
export function normalizeCnpj(input: string): string {
  return input.replace(PUNCTUATION, '').toUpperCase();
}

/** Calcula os dois dígitos verificadores a partir das 12 posições de base. */
export function calculateCnpjCheckDigits(base: string): string {
  if (base.length !== CNPJ_BASE_LENGTH) {
    throw new InvalidCnpjError(
      base,
      `base deve ter ${CNPJ_BASE_LENGTH} posições, recebidas ${base.length}`,
    );
  }

  if (!/^[0-9A-Z]{12}$/.test(base)) {
    throw new InvalidCnpjError(base, 'base deve conter apenas [0-9A-Z] em caixa alta');
  }

  const first = mod11CheckDigit(base);
  const second = mod11CheckDigit(`${base}${first}`);
  return `${first}${second}`;
}

/**
 * Verifica estrutura e dígitos verificadores.
 *
 * Devolve booleano porque CNPJ inválido é entrada esperada de usuário, não bug.
 */
export function isValidCnpj(input: string): boolean {
  const cnpj = normalizeCnpj(input);

  if (!CNPJ_PATTERN.test(cnpj)) {
    return false;
  }

  // Sequências de caractere único passam no módulo 11 mas não são CNPJ real.
  if (new Set(cnpj).size === 1) {
    return false;
  }

  const base = cnpj.slice(0, CNPJ_BASE_LENGTH);
  return calculateCnpjCheckDigits(base) === cnpj.slice(CNPJ_BASE_LENGTH);
}

/** Versão que lança — usada no pipeline de emissão, onde CNPJ ruim é bloqueio. */
export function assertValidCnpj(input: string): string {
  const cnpj = normalizeCnpj(input);

  if (!CNPJ_PATTERN.test(cnpj)) {
    throw new InvalidCnpjError(
      input,
      'não atende ao pattern TCnpj [0-9A-Z]{12}[0-9]{2} do PL_010f_v1.04',
    );
  }

  if (!isValidCnpj(cnpj)) {
    throw new InvalidCnpjError(input, 'dígitos verificadores não conferem');
  }

  return cnpj;
}

/** Aplica a máscara de exibição. Só para UI — nunca para o XML. */
export function formatCnpj(input: string): string {
  const cnpj = normalizeCnpj(input);
  if (cnpj.length !== CNPJ_LENGTH) {
    return input;
  }
  return (
    `${cnpj.slice(0, 2)}.${cnpj.slice(2, 5)}.${cnpj.slice(5, 8)}` +
    `/${cnpj.slice(8, 12)}-${cnpj.slice(12, 14)}`
  );
}
