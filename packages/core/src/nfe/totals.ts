/**
 * Totalização da NF-e.
 *
 * Os totais nunca chegam prontos de fora: são sempre derivados dos itens. Assim
 * o grupo `total` não tem como divergir do somatório de `det`, que é uma das
 * causas mais comuns de rejeição.
 *
 * Fórmula de `vNF` — base e grau de confirmação:
 *
 *   vNF = vProd − vDesc − vICMSDeson¹ + vST + vFCPST + vFrete + vSeg + vOutro
 *         + vII + vIPI + vIPIDevol (+ vPISST, vCOFINSST quando somados)
 *
 * ¹ só quando `indDeduzDeson = 1`.
 *
 * Extraída da implementação de referência sped-nfe (`TraitCalculations`), que
 * acrescenta IBS, CBS e IS apenas para anos posteriores a 2026. Não foi
 * conferida contra o texto da regra de validação no MOC — item listado para
 * validação fiscal. Dentro do escopo suportado (ICMSSN102, sem IPI, II ou ST),
 * a fórmula se reduz a `vProd − vDesc + vFrete + vSeg + vOutro`. Os demais
 * termos já existem como acumuladores para que um grupo novo de tributo entre
 * sem mudar a estrutura.
 */

import { assertNever } from '../assert-never.js';
import { Decimal, RoundingMode } from '../money/decimal.js';
import { InvalidNfeDocumentError, type IcmsGroup, type InvoiceItem, type SocialContributionGroup } from './document.js';

/**
 * `vProd = qCom × vUnCom`, reduzido a duas casas por `HalfUp`.
 *
 * O produto exato pode ter até 14 casas (4 da quantidade + 10 do preço), mais
 * que a escala interna do `Decimal`. Reduzir o produto em duas etapas com
 * `HalfUp` nas duas produz erro: 0,00499999999999 vira 0,0050000000 na primeira
 * redução e 0,01 na segunda, quando o correto é 0,00. Truncar na etapa
 * intermediária é exato para `HalfUp`, porque a fronteira de arredondamento em
 * duas casas cabe na escala intermediária e a truncagem nunca a atravessa.
 */
export function itemGrossValue(item: Pick<InvoiceItem, 'quantity' | 'unitPrice'>): Decimal {
  return item.quantity
    .times(item.unitPrice, RoundingMode.Truncate)
    .round(2, RoundingMode.HalfUp);
}

interface IcmsItemAmounts {
  readonly base: Decimal;
  readonly amount: Decimal;
  readonly exemption: Decimal;
  readonly povertyFund: Decimal;
  readonly substitutionBase: Decimal;
  readonly substitution: Decimal;
  readonly povertyFundSubstitution: Decimal;
  readonly povertyFundSubstitutionWithheld: Decimal;
}

const NO_ICMS: IcmsItemAmounts = {
  base: Decimal.ZERO,
  amount: Decimal.ZERO,
  exemption: Decimal.ZERO,
  povertyFund: Decimal.ZERO,
  substitutionBase: Decimal.ZERO,
  substitution: Decimal.ZERO,
  povertyFundSubstitution: Decimal.ZERO,
  povertyFundSubstitutionWithheld: Decimal.ZERO,
};

function icmsAmounts(icms: IcmsGroup): IcmsItemAmounts {
  switch (icms.kind) {
    // ICMSSN102 não tem base, valor, ST nem FCP: o grupo não carrega esses campos.
    case 'SimplesNacional102':
      return NO_ICMS;
    default:
      return assertNever(icms.kind);
  }
}

function contributionAmount(group: SocialContributionGroup): Decimal {
  return group.kind === 'NonTaxed' ? Decimal.ZERO : group.amount;
}

export interface InvoiceTotals {
  /** `vBC` */
  readonly icmsBase: Decimal;
  /** `vICMS` */
  readonly icmsAmount: Decimal;
  /** `vICMSDeson` */
  readonly icmsExemption: Decimal;
  /** `vFCP` */
  readonly povertyFund: Decimal;
  /** `vBCST` */
  readonly icmsSubstitutionBase: Decimal;
  /** `vST` */
  readonly icmsSubstitution: Decimal;
  /** `vFCPST` */
  readonly povertyFundSubstitution: Decimal;
  /** `vFCPSTRet` */
  readonly povertyFundSubstitutionWithheld: Decimal;
  /** `vProd` */
  readonly products: Decimal;
  /** `vFrete` */
  readonly freight: Decimal;
  /** `vSeg` */
  readonly insurance: Decimal;
  /** `vDesc` */
  readonly discount: Decimal;
  /** `vII` */
  readonly importTax: Decimal;
  /** `vIPI` */
  readonly ipi: Decimal;
  /** `vIPIDevol` */
  readonly ipiReturned: Decimal;
  /** `vPIS` */
  readonly pis: Decimal;
  /** `vCOFINS` */
  readonly cofins: Decimal;
  /** `vOutro` */
  readonly otherExpenses: Decimal;
  /** `vNF` */
  readonly invoice: Decimal;
}

const orZero = (value: Decimal | undefined): Decimal => value ?? Decimal.ZERO;

export function computeTotals(items: readonly InvoiceItem[]): InvoiceTotals {
  if (items.length === 0) {
    throw new InvalidNfeDocumentError('A NF-e precisa de ao menos um item.');
  }

  let icmsBase = Decimal.ZERO;
  let icmsAmount = Decimal.ZERO;
  let icmsExemption = Decimal.ZERO;
  let povertyFund = Decimal.ZERO;
  let icmsSubstitutionBase = Decimal.ZERO;
  let icmsSubstitution = Decimal.ZERO;
  let povertyFundSubstitution = Decimal.ZERO;
  let povertyFundSubstitutionWithheld = Decimal.ZERO;
  let products = Decimal.ZERO;
  let freight = Decimal.ZERO;
  let insurance = Decimal.ZERO;
  let discount = Decimal.ZERO;
  let otherExpenses = Decimal.ZERO;
  let pis = Decimal.ZERO;
  let cofins = Decimal.ZERO;

  for (const item of items) {
    const icms = icmsAmounts(item.taxes.icms);
    icmsBase = icmsBase.plus(icms.base);
    icmsAmount = icmsAmount.plus(icms.amount);
    icmsExemption = icmsExemption.plus(icms.exemption);
    povertyFund = povertyFund.plus(icms.povertyFund);
    icmsSubstitutionBase = icmsSubstitutionBase.plus(icms.substitutionBase);
    icmsSubstitution = icmsSubstitution.plus(icms.substitution);
    povertyFundSubstitution = povertyFundSubstitution.plus(icms.povertyFundSubstitution);
    povertyFundSubstitutionWithheld = povertyFundSubstitutionWithheld.plus(
      icms.povertyFundSubstitutionWithheld,
    );

    products = products.plus(itemGrossValue(item));
    freight = freight.plus(orZero(item.freight));
    insurance = insurance.plus(orZero(item.insurance));
    discount = discount.plus(orZero(item.discount));
    otherExpenses = otherExpenses.plus(orZero(item.otherExpenses));
    pis = pis.plus(contributionAmount(item.taxes.pis));
    cofins = cofins.plus(contributionAmount(item.taxes.cofins));
  }

  // Sem grupos de IPI e II no escopo suportado; permanecem zero até existirem.
  const importTax = Decimal.ZERO;
  const ipi = Decimal.ZERO;
  const ipiReturned = Decimal.ZERO;

  const invoice = products
    .minus(discount)
    .plus(icmsSubstitution)
    .plus(povertyFundSubstitution)
    .plus(freight)
    .plus(insurance)
    .plus(otherExpenses)
    .plus(importTax)
    .plus(ipi)
    .plus(ipiReturned);

  if (invoice.isNegative()) {
    throw new InvalidNfeDocumentError(
      `Total da NF-e negativo (${invoice.toFixed(2)}): os descontos superam os valores dos itens.`,
    );
  }

  return {
    icmsBase,
    icmsAmount,
    icmsExemption,
    povertyFund,
    icmsSubstitutionBase,
    icmsSubstitution,
    povertyFundSubstitution,
    povertyFundSubstitutionWithheld,
    products,
    freight,
    insurance,
    discount,
    importTax,
    ipi,
    ipiReturned,
    pis,
    cofins,
    otherExpenses,
    invoice,
  };
}
