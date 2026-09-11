/**
 * CPF.
 *
 * Diferente do CNPJ, o CPF não foi alterado pela NT 2026.004 e segue numérico —
 * `TCpf` no PL_010f_v1.04 é `[0-9]{11}`. O cálculo do DV também é outro: os
 * pesos crescem até 10 e 11 em vez de ciclar de 2 a 9, então o módulo 11 da
 * chave de acesso não serve aqui.
 */

import { FiscalError } from '../errors.js';

export const CPF_LENGTH = 11;
export const CPF_BASE_LENGTH = 9;

const CPF_PATTERN = /^[0-9]{11}$/;
const CPF_BASE_PATTERN = /^[0-9]{9}$/;
const MASK = /[.\-\s]/g;

export class InvalidCpfError extends FiscalError {
  constructor(
    readonly value: string,
    reason: string,
  ) {
    super(`CPF ${JSON.stringify(value)} inválido: ${reason}`);
  }
}

export function normalizeCpf(input: string): string {
  return input.replace(MASK, '');
}

/** Pesos decrescentes a partir de `tamanho + 1`: 10..2 no primeiro DV, 11..2 no segundo. */
function checkDigit(digits: string): number {
  const firstWeight = digits.length + 1;
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    sum += Number(digits[index]) * (firstWeight - index);
  }
  const remainder = (sum * 10) % 11;
  return remainder === 10 ? 0 : remainder;
}

export function calculateCpfCheckDigits(base: string): string {
  if (!CPF_BASE_PATTERN.test(base)) {
    throw new InvalidCpfError(base, `base deve ter ${CPF_BASE_LENGTH} dígitos`);
  }
  const first = checkDigit(base);
  const second = checkDigit(`${base}${first}`);
  return `${first}${second}`;
}

export function isValidCpf(input: string): boolean {
  const cpf = normalizeCpf(input);
  if (!CPF_PATTERN.test(cpf)) {
    return false;
  }
  // Sequências de dígito único passam no cálculo mas não são CPF emitido.
  if (new Set(cpf).size === 1) {
    return false;
  }
  return calculateCpfCheckDigits(cpf.slice(0, CPF_BASE_LENGTH)) === cpf.slice(CPF_BASE_LENGTH);
}

export function assertValidCpf(input: string): string {
  const cpf = normalizeCpf(input);
  if (!CPF_PATTERN.test(cpf)) {
    throw new InvalidCpfError(input, 'deve conter 11 dígitos');
  }
  if (!isValidCpf(cpf)) {
    throw new InvalidCpfError(input, 'dígitos verificadores não conferem');
  }
  return cpf;
}
