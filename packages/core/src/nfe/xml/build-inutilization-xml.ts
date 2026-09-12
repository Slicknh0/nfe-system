/**
 * Pedido de inutilização de numeração (`inutNFe`), ainda sem assinatura.
 *
 * Leiaute: `TInutNFe` em `leiauteInutNFe_v4.00.xsd` do PL_010d_v1.03. O `Id`
 * é derivado aqui dos mesmos campos que vão no corpo do pedido, então não há
 * como divergirem (regra I04.a, rejeição 502).
 *
 * Regras da SEFAZ verificadas localmente, antes de gastar uma chamada
 * (MOC 7.0, Visão Geral, 5.3.4):
 * - I02b/I02c: ano entre 2006 e o ano corrente (453/454);
 * - I03: número inicial não maior que o final (224);
 * - I04: no máximo 10.000 números por pedido (201).
 */

import { FiscalError } from '../../errors.js';
import { assertValidCnpj } from '../../fiscal/cnpj.js';
import { DEFAULT_ISSUER_TIME_ZONE, NFE_MODEL } from '../../fiscal/access-key.js';
import { toZonedDateTime } from '../../time/zoned-time.js';
import { element, leaf, serializeXml } from '../../xml/element.js';
import type { Environment } from '../document.js';
import { NFE_LAYOUT_VERSION, NFE_NAMESPACE } from './build-nfe-xml.js';
import { fiscalText } from './text.js';

export class InvalidInutilizationRequestError extends FiscalError {}

/** Literal obrigatório de `xServ` (enumeração do leiaute). */
export const INUTILIZATION_SERVICE = 'INUTILIZAR';

/** Regra I04: acima disso a SEFAZ rejeita com 201. */
export const MAX_NUMBERS_PER_INUTILIZATION = 10_000;

const FIRST_ALLOWED_YEAR = 2006;
const MAX_INVOICE_NUMBER = 999_999_999;
const MAX_SERIES = 999;
const JUSTIFICATION_MIN_LENGTH = 15;
const JUSTIFICATION_MAX_LENGTH = 255;
const ID_LENGTH = 43;

export interface InutilizationRequest {
  readonly environment: Environment;
  /** `cUF` do emitente. */
  readonly stateCode: number;
  /** Ano da numeração, com quatro dígitos. Vai para o XML com dois (`Tano`). */
  readonly year: number;
  readonly cnpj: string;
  readonly series: number;
  readonly firstNumber: number;
  readonly lastNumber: number;
  /** `xJust`: 15 a 255 caracteres (`TJust`). */
  readonly justification: string;
}

export interface UnsignedInutilization {
  /** Atributo `Id` de `infInut`, referenciado pela assinatura. */
  readonly id: string;
  readonly xml: string;
}

export interface InutilizationOptions {
  /** Instante de referência para "ano corrente". Padrão: agora. */
  readonly now?: Date;
  readonly timeZone?: string;
}

/** Ano (quatro dígitos) da numeração de uma chave de acesso. */
export function inutilizationYear(accessKey: string): number {
  const twoDigits = Number(accessKey.slice(2, 4));
  if (!/^[0-9]{2}/.test(accessKey.slice(2, 4)) || Number.isNaN(twoDigits)) {
    throw new InvalidInutilizationRequestError('Chave de acesso sem ano válido nas posições 3 e 4.');
  }
  return 2000 + twoDigits;
}

function assertInteger(field: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new InvalidInutilizationRequestError(
      `Campo ${field}: esperado inteiro entre ${min} e ${max}, recebido ${value}.`,
    );
  }
}

export function buildUnsignedInutilization(
  request: InutilizationRequest,
  options: InutilizationOptions = {},
): UnsignedInutilization {
  const currentYear = Number(
    toZonedDateTime(options.now ?? new Date(), options.timeZone ?? DEFAULT_ISSUER_TIME_ZONE).year,
  );

  assertInteger('cUF', request.stateCode, 10, 99);
  assertInteger('ano', request.year, FIRST_ALLOWED_YEAR, currentYear);
  assertInteger('serie', request.series, 0, MAX_SERIES);
  assertInteger('nNFIni', request.firstNumber, 1, MAX_INVOICE_NUMBER);
  assertInteger('nNFFin', request.lastNumber, 1, MAX_INVOICE_NUMBER);

  if (request.firstNumber > request.lastNumber) {
    throw new InvalidInutilizationRequestError(
      `A faixa inicial (${request.firstNumber}) é maior que a final (${request.lastNumber}).`,
    );
  }
  const quantity = request.lastNumber - request.firstNumber + 1;
  if (quantity > MAX_NUMBERS_PER_INUTILIZATION) {
    throw new InvalidInutilizationRequestError(
      `A faixa tem ${quantity} números; o limite por pedido é ${MAX_NUMBERS_PER_INUTILIZATION}.`,
    );
  }

  const justification = fiscalText('xJust', request.justification);
  if (
    justification.length < JUSTIFICATION_MIN_LENGTH ||
    justification.length > JUSTIFICATION_MAX_LENGTH
  ) {
    throw new InvalidInutilizationRequestError(
      `Campo xJust: a justificativa deve ter de ${JUSTIFICATION_MIN_LENGTH} a ${JUSTIFICATION_MAX_LENGTH} caracteres; tem ${justification.length}.`,
    );
  }

  const cnpj = assertValidCnpj(request.cnpj);
  const year = String(request.year % 100).padStart(2, '0');
  const stateCode = String(request.stateCode);
  const model = String(NFE_MODEL);

  const id =
    `ID${stateCode}${year}${cnpj}${model}` +
    `${String(request.series).padStart(3, '0')}` +
    `${String(request.firstNumber).padStart(9, '0')}` +
    `${String(request.lastNumber).padStart(9, '0')}`;
  if (id.length !== ID_LENGTH) {
    throw new InvalidInutilizationRequestError(`Id do pedido com ${id.length} posições; esperado ${ID_LENGTH}.`);
  }

  const infInut = element(
    'infInut',
    [
      leaf('tpAmb', String(request.environment)),
      leaf('xServ', INUTILIZATION_SERVICE),
      leaf('cUF', stateCode),
      leaf('ano', year),
      leaf('CNPJ', cnpj),
      leaf('mod', model),
      leaf('serie', String(request.series)),
      leaf('nNFIni', String(request.firstNumber)),
      leaf('nNFFin', String(request.lastNumber)),
      leaf('xJust', justification),
    ],
    { Id: id },
  );

  const root = element('inutNFe', [infInut], { xmlns: NFE_NAMESPACE, versao: NFE_LAYOUT_VERSION });
  return { id, xml: serializeXml(root) };
}
