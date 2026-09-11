/** Grupo `det` — item da NF-e, com produto (`prod`) e tributos (`imposto`). */

import { assertNever } from '../../assert-never.js';
import { WITHOUT_GTIN, isValidGtin } from '../../fiscal/gtin.js';
import type { Decimal } from '../../money/decimal.js';
import { element, leaf, optionalLeaf, type XmlElement } from '../../xml/element.js';
import type { IcmsGroup, InvoiceItem, ItemTaxes, SocialContributionGroup } from '../document.js';
import { itemGrossValue } from '../totals.js';
import { formatMonetaryValue, formatPercentage, formatQuantity, formatUnitValue } from './format.js';
import { CEST, CFOP, NCM, TAX_SITUATION_CODE } from './patterns.js';
import {
  InvalidFiscalTextError,
  codeValue,
  fiscalText,
  optionalCodeValue,
  optionalFiscalText,
} from './text.js';

/** `indTot = 1`: o item compõe o total da NF-e. Único valor suportado nesta fatia. */
const COUNTS_TOWARD_TOTAL = '1';

type FieldPath = (tag: string) => string;

function gtinValue(field: string, gtin: string | undefined): string {
  if (gtin === undefined) {
    return WITHOUT_GTIN;
  }
  if (!isValidGtin(gtin)) {
    throw new InvalidFiscalTextError(
      field,
      `GTIN ${JSON.stringify(gtin)} inválido: esperado 8, 12, 13 ou 14 dígitos com dígito ` +
        `verificador GS1 correto. Para produto sem GTIN, omita o campo.`,
    );
  }
  return gtin;
}

/** Valores opcionais zerados são omitidos em vez de informados como `0.00`. */
function positiveAmountLeaf(
  tag: string,
  value: Decimal | undefined,
  path: FieldPath,
): XmlElement | undefined {
  if (value === undefined || value.isZero()) {
    return undefined;
  }
  return leaf(tag, formatMonetaryValue(path(tag), value));
}

function buildProd(item: InvoiceItem, path: FieldPath): XmlElement {
  const gtin = gtinValue(path('cEAN'), item.gtin);
  const unit = fiscalText(path('uCom'), item.unit);
  const quantity = formatQuantity(path('qCom'), item.quantity);
  const unitPrice = formatUnitValue(path('vUnCom'), item.unitPrice);

  return element('prod', [
    leaf('cProd', fiscalText(path('cProd'), item.productCode)),
    leaf('cEAN', gtin),
    leaf('xProd', fiscalText(path('xProd'), item.description)),
    leaf('NCM', codeValue(path('NCM'), item.ncm, NCM)),
    optionalLeaf('CEST', optionalCodeValue(path('CEST'), item.cest, CEST)),
    leaf('CFOP', codeValue(path('CFOP'), item.cfop, CFOP)),
    leaf('uCom', unit),
    leaf('qCom', quantity),
    leaf('vUnCom', unitPrice),
    leaf('vProd', formatMonetaryValue(path('vProd'), itemGrossValue(item))),
    // Unidade tributável igual à comercial nesta fatia.
    leaf('cEANTrib', gtin),
    leaf('uTrib', unit),
    leaf('qTrib', quantity),
    leaf('vUnTrib', unitPrice),
    positiveAmountLeaf('vFrete', item.freight, path),
    positiveAmountLeaf('vSeg', item.insurance, path),
    positiveAmountLeaf('vDesc', item.discount, path),
    positiveAmountLeaf('vOutro', item.otherExpenses, path),
    leaf('indTot', COUNTS_TOWARD_TOTAL),
  ]);
}

function buildIcms(icms: IcmsGroup): XmlElement {
  switch (icms.kind) {
    case 'SimplesNacional102':
      return element('ICMS', [
        element('ICMSSN102', [leaf('orig', String(icms.origin)), leaf('CSOSN', icms.csosn)]),
      ]);
    default:
      return assertNever(icms.kind);
  }
}

function buildContribution(
  tax: 'PIS' | 'COFINS',
  group: SocialContributionGroup,
  path: FieldPath,
): XmlElement {
  const cst = codeValue(path(`${tax}/CST`), group.cst, TAX_SITUATION_CODE);

  switch (group.kind) {
    case 'NonTaxed':
      return element(tax, [element(`${tax}NT`, [leaf('CST', cst)])]);
    case 'Rate':
    case 'Other': {
      const variant = group.kind === 'Rate' ? 'Aliq' : 'Outr';
      return element(tax, [
        element(`${tax}${variant}`, [
          leaf('CST', cst),
          leaf('vBC', formatMonetaryValue(path(`${tax}/vBC`), group.base)),
          leaf(`p${tax}`, formatPercentage(path(`${tax}/p${tax}`), group.rate)),
          leaf(`v${tax}`, formatMonetaryValue(path(`${tax}/v${tax}`), group.amount)),
        ]),
      ]);
    }
    default:
      return assertNever(group);
  }
}

/**
 * Ordem exigida pelo XSD:
 * `vTotTrib? · ICMS · IPI? · II? · PIS? · PISST? · COFINS? · COFINSST? · ICMSUFDest? · IS? · IBSCBS?`
 *
 * `IS` e `IBSCBS` ocupam as duas últimas posições. Para CRT=1 eles só passam a
 * valer em 2027 e a NT correspondente ainda não foi publicada.
 */
function buildImposto(taxes: ItemTaxes, path: FieldPath): XmlElement {
  return element('imposto', [
    buildIcms(taxes.icms),
    buildContribution('PIS', taxes.pis, path),
    buildContribution('COFINS', taxes.cofins, path),
  ]);
}

/** `position` começa em 1 e vira o atributo `nItem`. */
export function buildDet(item: InvoiceItem, position: number): XmlElement {
  const path: FieldPath = (tag) => `det[${position}]/${tag}`;

  return element(
    'det',
    [
      buildProd(item, path),
      buildImposto(item.taxes, path),
      optionalLeaf('infAdProd', optionalFiscalText(path('infAdProd'), item.additionalInformation)),
    ],
    { nItem: String(position) },
  );
}
