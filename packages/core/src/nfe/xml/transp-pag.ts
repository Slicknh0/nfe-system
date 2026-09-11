/** Grupos `transp` e `pag` — transporte e pagamento. */

import { element, leaf, optionalLeaf, type XmlElement } from '../../xml/element.js';
import { InvalidNfeDocumentError, type Payment, type Transport } from '../document.js';
import { formatMonetaryValue } from './format.js';
import { PAYMENT_METHOD } from './patterns.js';
import { codeValue } from './text.js';

/** `detPag` admite de 1 a 100 ocorrências no XSD. */
const MAX_PAYMENT_ENTRIES = 100;

export function buildTransp(transport: Transport): XmlElement {
  return element('transp', [leaf('modFrete', String(transport.freightMode))]);
}

export function buildPag(payment: Payment): XmlElement {
  const { entries, change } = payment;

  if (entries.length === 0 || entries.length > MAX_PAYMENT_ENTRIES) {
    throw new InvalidNfeDocumentError(
      `O grupo de pagamento exige de 1 a ${MAX_PAYMENT_ENTRIES} formas de pagamento; ` +
        `recebidas ${entries.length}.`,
    );
  }

  const details = entries.map((entry, index) => {
    const path = `pag/detPag[${index + 1}]`;
    return element('detPag', [
      optionalLeaf('indPag', entry.indicator === undefined ? undefined : String(entry.indicator)),
      leaf('tPag', codeValue(`${path}/tPag`, entry.method, PAYMENT_METHOD)),
      leaf('vPag', formatMonetaryValue(`${path}/vPag`, entry.amount)),
    ]);
  });

  const changeLeaf =
    change === undefined || change.isZero()
      ? undefined
      : leaf('vTroco', formatMonetaryValue('pag/vTroco', change));

  return element('pag', [...details, changeLeaf]);
}
