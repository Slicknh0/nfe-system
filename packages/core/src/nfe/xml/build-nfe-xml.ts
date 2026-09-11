/**
 * Montagem do XML da NF-e, ainda sem assinatura.
 *
 * O resultado não passa sozinho na validação de schema: `ds:Signature` é
 * obrigatória no tipo `TNFe`. Validar contra o XSD é tarefa do pipeline depois
 * da assinatura.
 *
 * Chave de acesso, `Id`, `cDV` e totais são todos derivados aqui, dos mesmos
 * dados, na mesma chamada. Não há como a chave do atributo `Id` divergir da
 * chave formada pelos campos de `ide`.
 */

import { NFE_MODEL, buildAccessKey } from '../../fiscal/access-key.js';
import { assertValidCnpj } from '../../fiscal/cnpj.js';
import { element, serializeXml } from '../../xml/element.js';
import { InvalidNfeDocumentError, NFE_ALLOWED_EMISSION_TYPES, type NfeDocument } from '../document.js';
import { computeTotals, type InvoiceTotals } from '../totals.js';
import { buildDet } from './det.js';
import { buildDest, buildEmit } from './emit-dest.js';
import { buildIde } from './ide.js';
import { buildInfAdic, buildInfRespTec } from './inf-adic-resp-tec.js';
import { buildTotal } from './total.js';
import { buildPag, buildTransp } from './transp-pag.js';

export const NFE_NAMESPACE = 'http://www.portalfiscal.inf.br/nfe';

/** `TVerNFe` no PL_010f_v1.04 é o pattern `4\.00`. */
export const NFE_LAYOUT_VERSION = '4.00';

/** `det` admite de 1 a 990 ocorrências no XSD. */
export const MAX_ITEMS = 990;

export interface UnsignedNfe {
  readonly accessKey: string;
  /** Valor do atributo `Id` de `infNFe`, referenciado pela assinatura. */
  readonly infNFeId: string;
  readonly xml: string;
  readonly totals: InvoiceTotals;
}

function assertSupportedDocument(document: NfeDocument): void {
  const { emissionType } = document.identification;
  if (!NFE_ALLOWED_EMISSION_TYPES.has(emissionType)) {
    throw new InvalidNfeDocumentError(
      `Tipo de emissão ${emissionType} não é aceito para NF-e modelo 55 neste sistema.`,
    );
  }

  const itemCount = document.items.length;
  if (itemCount === 0 || itemCount > MAX_ITEMS) {
    throw new InvalidNfeDocumentError(
      `A NF-e exige de 1 a ${MAX_ITEMS} itens; recebidos ${itemCount}.`,
    );
  }
}

export function buildUnsignedNfe(document: NfeDocument): UnsignedNfe {
  assertSupportedDocument(document);

  const { identification } = document;
  const accessKey = buildAccessKey({
    cUF: identification.stateCode,
    issueDate: identification.issuedAt,
    cnpj: assertValidCnpj(document.issuer.cnpj),
    model: NFE_MODEL,
    series: identification.series,
    number: identification.number,
    tpEmis: identification.emissionType,
    cNF: identification.randomCode,
    timeZone: identification.timeZone,
  });

  const totals = computeTotals(document.items);
  const infNFeId = `NFe${accessKey}`;

  const infNFe = element(
    'infNFe',
    [
      buildIde(identification, accessKey),
      buildEmit(document.issuer),
      buildDest(document.recipient),
      ...document.items.map((item, index) => buildDet(item, index + 1)),
      buildTotal(totals),
      buildTransp(document.transport),
      buildPag(document.payment),
      buildInfAdic(document.additionalInformation),
      buildInfRespTec(document.technicalResponsible),
    ],
    { versao: NFE_LAYOUT_VERSION, Id: infNFeId },
  );

  const root = element('NFe', [infNFe], { xmlns: NFE_NAMESPACE });

  return { accessKey, infNFeId, xml: serializeXml(root), totals };
}
