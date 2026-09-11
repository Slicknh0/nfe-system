/** Grupos `infAdic` e `infRespTec` — informações adicionais e responsável técnico. */

import { assertValidCnpj } from '../../fiscal/cnpj.js';
import { element, leaf, optionalLeaf, type XmlElement } from '../../xml/element.js';
import type { AdditionalInformation, TechnicalResponsible } from '../document.js';
import { PHONE } from './patterns.js';
import { codeValue, fiscalText, optionalFiscalText } from './text.js';

export function buildInfAdic(information: AdditionalInformation | undefined): XmlElement | undefined {
  if (information === undefined) {
    return undefined;
  }

  const forTaxAuthority = optionalFiscalText('infAdic/infAdFisco', information.forTaxAuthority);
  const complementary = optionalFiscalText('infAdic/infCpl', information.complementary);

  if (forTaxAuthority === undefined && complementary === undefined) {
    return undefined;
  }

  return element('infAdic', [
    optionalLeaf('infAdFisco', forTaxAuthority),
    optionalLeaf('infCpl', complementary),
  ]);
}

/**
 * Responsável técnico pelo sistema emissor.
 *
 * O grupo é `minOccurs="0"` no XSD; a obrigatoriedade por UF vem de regra de
 * validação e não foi confirmada nesta fatia. `idCSRT` e `hashCSRT` ficam de
 * fora até existir CSRT cadastrado.
 */
export function buildInfRespTec(
  responsible: TechnicalResponsible | undefined,
): XmlElement | undefined {
  if (responsible === undefined) {
    return undefined;
  }

  return element('infRespTec', [
    leaf('CNPJ', assertValidCnpj(responsible.cnpj)),
    leaf('xContato', fiscalText('infRespTec/xContato', responsible.contactName)),
    leaf('email', fiscalText('infRespTec/email', responsible.email)),
    leaf('fone', codeValue('infRespTec/fone', responsible.phone, PHONE)),
  ]);
}
