/**
 * Chave de acesso da NF-e (44 posições).
 *
 * Estrutura derivada do pattern oficial `TChNFe` do PL_010f_v1.04:
 * `[0-9]{6}[0-9A-Z]{12}[0-9]{26}`
 *
 * ```
 *  1- 2  cUF     2 numéricos   ─┐
 *  3- 6  AAMM    4 numéricos   ─┴─ [0-9]{6}
 *  7-18  CNPJ   12 alfanum     ─── [0-9A-Z]{12}
 * 19-20  DV CNPJ 2 numéricos   ─┐
 * 21-22  modelo  2 numéricos    │
 * 23-25  série   3 numéricos    │
 * 26-34  nNF     9 numéricos    ├─ [0-9]{26}
 * 35     tpEmis  1 numérico     │
 * 36-43  cNF     8 numéricos    │
 * 44     cDV     1 numérico    ─┘
 * ```
 *
 * A chave é o identificador do documento fiscal. Ela precisa ser idêntica no
 * banco, no XML, no protocolo e no DANFE — por isso a geração vive num módulo
 * isolado, sem dependência de infraestrutura, e é sempre derivada dos mesmos
 * campos.
 */

import { FiscalError } from '../errors.js';
import { mod11CheckDigit } from './mod11.js';

/** Pattern do tipo `TCnpj` no PL_010f_v1.04: 12 alfanuméricos + 2 dígitos. */
const CNPJ_PATTERN = /^[0-9A-Z]{12}[0-9]{2}$/;

/** Pattern do tipo `TChNFe` no PL_010f_v1.04. */
const ACCESS_KEY_PATTERN = /^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$/;

const CNF_PATTERN = /^[0-9]{8}$/;

export const ACCESS_KEY_LENGTH = 44;

/** Modelos de documento cobertos por esta implementação. */
export const NFE_MODEL = 55;

export class AccessKeyValidationError extends FiscalError {}

export interface AccessKeyInput {
  /** Código IBGE da UF do emitente (`cUF`). */
  readonly cUF: number;
  /** Data de emissão; contribui com ano e mês (AAMM). */
  readonly issueDate: Date;
  /** CNPJ do emitente com 14 posições, já em caixa alta. */
  readonly cnpj: string;
  /** Modelo do documento — 55 para NF-e. */
  readonly model: number;
  /** Série (0..999). */
  readonly series: number;
  /** Número da NF-e (1..999999999). */
  readonly number: number;
  /** Tipo de emissão (`tpEmis`). */
  readonly tpEmis: number;
  /** Código numérico de 8 posições (`cNF`). */
  readonly cNF: string;
  /**
   * Fuso IANA do estabelecimento emitente, usado para derivar AAMM.
   *
   * Existe porque `Date` é um instante absoluto: uma nota emitida às 23h30 de
   * 31/01 em Brasília é 01/02 em UTC, e derivar a competência do UTC gerava
   * chave com o mês seguinte. O valor correto vem do cadastro do emitente.
   */
  readonly timeZone?: string;
}

/** Fuso adotado quando o emitente não informa o seu. */
export const DEFAULT_ISSUER_TIME_ZONE = 'America/Sao_Paulo';

export interface ParsedAccessKey {
  readonly cUF: number;
  readonly year: number;
  readonly month: number;
  readonly cnpj: string;
  readonly model: number;
  readonly series: number;
  readonly number: number;
  readonly tpEmis: number;
  readonly cNF: string;
  readonly checkDigit: number;
}

function padNumber(value: number, length: number): string {
  return String(value).padStart(length, '0');
}

/**
 * Extrai ano e mês conforme o calendário do fuso informado.
 *
 * `Intl.DateTimeFormat` é usado em vez de aritmética de offset porque o offset
 * de um fuso não é constante ao longo do ano.
 */
function localYearAndMonth(instant: Date, timeZone: string): { year: string; month: string } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
    }).formatToParts(instant);
  } catch {
    throw new AccessKeyValidationError(
      `Fuso horário inválido para o emitente: ${JSON.stringify(timeZone)}.`,
    );
  }

  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;

  if (year === undefined || month === undefined) {
    throw new AccessKeyValidationError('Não foi possível derivar AAMM da data de emissão.');
  }

  return { year: year.slice(-2), month };
}

function assertIntegerInRange(
  value: number,
  min: number,
  max: number,
  fieldName: string,
): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new AccessKeyValidationError(
      `Campo ${fieldName} inválido: esperado inteiro entre ${min} e ${max}, recebido ${value}.`,
    );
  }
}

/**
 * Monta a chave de acesso e anexa o dígito verificador.
 *
 * Entradas fora do leiaute lançam erro em vez de serem truncadas ou
 * normalizadas: uma chave silenciosamente ajustada divergiria do documento que
 * o contribuinte pensa ter emitido.
 */
export function buildAccessKey(input: AccessKeyInput): string {
  assertIntegerInRange(input.cUF, 11, 53, 'cUF');
  assertIntegerInRange(input.model, 1, 99, 'modelo');
  assertIntegerInRange(input.series, 0, 999, 'série');
  assertIntegerInRange(input.number, 1, 999_999_999, 'nNF');
  assertIntegerInRange(input.tpEmis, 1, 9, 'tpEmis');

  if (!CNPJ_PATTERN.test(input.cnpj)) {
    throw new AccessKeyValidationError(
      `CNPJ ${JSON.stringify(input.cnpj)} não atende ao pattern TCnpj ` +
        `[0-9A-Z]{12}[0-9]{2} do PL_010f_v1.04. CNPJ alfanumérico deve vir em caixa alta.`,
    );
  }

  if (!CNF_PATTERN.test(input.cNF)) {
    throw new AccessKeyValidationError(
      `cNF ${JSON.stringify(input.cNF)} inválido: esperados exatamente 8 dígitos.`,
    );
  }

  if (Number.isNaN(input.issueDate.getTime())) {
    throw new AccessKeyValidationError('Data de emissão inválida.');
  }

  const { year, month } = localYearAndMonth(
    input.issueDate,
    input.timeZone ?? DEFAULT_ISSUER_TIME_ZONE,
  );

  const body =
    padNumber(input.cUF, 2) +
    year +
    month +
    input.cnpj +
    padNumber(input.model, 2) +
    padNumber(input.series, 3) +
    padNumber(input.number, 9) +
    padNumber(input.tpEmis, 1) +
    input.cNF;

  if (body.length !== ACCESS_KEY_LENGTH - 1) {
    throw new AccessKeyValidationError(
      `Corpo da chave com ${body.length} posições; esperadas ${ACCESS_KEY_LENGTH - 1}.`,
    );
  }

  return body + String(mod11CheckDigit(body));
}

/** Divide uma chave já formada nos campos que a compõem. */
export function parseAccessKey(key: string): ParsedAccessKey {
  if (!ACCESS_KEY_PATTERN.test(key)) {
    throw new AccessKeyValidationError(
      `Chave de acesso não atende ao pattern TChNFe do PL_010f_v1.04.`,
    );
  }

  return {
    cUF: Number(key.slice(0, 2)),
    year: 2000 + Number(key.slice(2, 4)),
    month: Number(key.slice(4, 6)),
    cnpj: key.slice(6, 20),
    model: Number(key.slice(20, 22)),
    series: Number(key.slice(22, 25)),
    number: Number(key.slice(25, 34)),
    tpEmis: Number(key.slice(34, 35)),
    cNF: key.slice(35, 43),
    checkDigit: Number(key.slice(43, 44)),
  };
}

/**
 * Confere estrutura e dígito verificador.
 *
 * Devolve booleano em vez de lançar porque é usado em filtros de busca e em
 * validação de entrada do usuário, onde chave inválida é caso esperado.
 */
export function isValidAccessKey(key: string): boolean {
  if (!ACCESS_KEY_PATTERN.test(key)) {
    return false;
  }

  const body = key.slice(0, ACCESS_KEY_LENGTH - 1);
  const informedCheckDigit = Number(key.slice(ACCESS_KEY_LENGTH - 1));

  return mod11CheckDigit(body) === informedCheckDigit;
}
