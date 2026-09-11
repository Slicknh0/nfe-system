/** Grupo `total/ICMSTot` — montado exclusivamente a partir de `computeTotals`. */

import type { Decimal } from '../../money/decimal.js';
import { element, leaf, type XmlElement } from '../../xml/element.js';
import type { InvoiceTotals } from '../totals.js';
import { formatMonetaryValue } from './format.js';

export function buildTotal(totals: InvoiceTotals): XmlElement {
  const amount = (tag: string, value: Decimal): XmlElement =>
    leaf(tag, formatMonetaryValue(`total/ICMSTot/${tag}`, value));

  return element('total', [
    element('ICMSTot', [
      amount('vBC', totals.icmsBase),
      amount('vICMS', totals.icmsAmount),
      amount('vICMSDeson', totals.icmsExemption),
      amount('vFCP', totals.povertyFund),
      amount('vBCST', totals.icmsSubstitutionBase),
      amount('vST', totals.icmsSubstitution),
      amount('vFCPST', totals.povertyFundSubstitution),
      amount('vFCPSTRet', totals.povertyFundSubstitutionWithheld),
      amount('vProd', totals.products),
      amount('vFrete', totals.freight),
      amount('vSeg', totals.insurance),
      amount('vDesc', totals.discount),
      amount('vII', totals.importTax),
      amount('vIPI', totals.ipi),
      amount('vIPIDevol', totals.ipiReturned),
      amount('vPIS', totals.pis),
      amount('vCOFINS', totals.cofins),
      amount('vOutro', totals.otherExpenses),
      amount('vNF', totals.invoice),
    ]),
  ]);
}
