/** Grupos `emit` e `dest` — emitente e destinatário, com seus endereços. */

import { assertValidCnpj } from '../../fiscal/cnpj.js';
import { assertValidCpf } from '../../fiscal/cpf.js';
import { element, leaf, optionalLeaf, type XmlChild, type XmlElement } from '../../xml/element.js';
import {
  InvalidNfeDocumentError,
  StateRegistrationIndicator,
  type Address,
  type Issuer,
  type Recipient,
} from '../document.js';
import {
  CNAE,
  MUNICIPALITY_CODE,
  PHONE,
  POSTAL_CODE,
  STATE,
  STATE_REGISTRATION,
} from './patterns.js';
import { codeValue, fiscalText, optionalCodeValue, optionalFiscalText } from './text.js';

/** Código e nome do Brasil na tabela de países usada pelo leiaute. */
const BRAZIL_COUNTRY_CODE = '1058';
const BRAZIL_COUNTRY_NAME = 'Brasil';

function buildAddress(tag: 'enderEmit' | 'enderDest', address: Address, owner: string): XmlElement {
  const path = (child: string): string => `${owner}/${tag}/${child}`;

  return element(tag, [
    leaf('xLgr', fiscalText(path('xLgr'), address.street)),
    leaf('nro', fiscalText(path('nro'), address.number)),
    optionalLeaf('xCpl', optionalFiscalText(path('xCpl'), address.complement)),
    leaf('xBairro', fiscalText(path('xBairro'), address.district)),
    leaf('cMun', codeValue(path('cMun'), address.municipalityCode, MUNICIPALITY_CODE)),
    leaf('xMun', fiscalText(path('xMun'), address.municipalityName)),
    leaf('UF', codeValue(path('UF'), address.state, STATE)),
    leaf('CEP', codeValue(path('CEP'), address.postalCode, POSTAL_CODE)),
    leaf('cPais', BRAZIL_COUNTRY_CODE),
    leaf('xPais', BRAZIL_COUNTRY_NAME),
    optionalLeaf('fone', optionalCodeValue(path('fone'), address.phone, PHONE)),
  ]);
}

/** No leiaute, `CNAE` só pode aparecer quando `IM` é informada. */
function municipalRegistrationChildren(issuer: Issuer): XmlChild[] {
  const registration = issuer.municipalRegistration;
  if (registration === undefined) {
    return [];
  }
  return [
    leaf('IM', fiscalText('emit/IM', registration.number)),
    optionalLeaf('CNAE', optionalCodeValue('emit/CNAE', registration.cnae, CNAE)),
  ];
}

export function buildEmit(issuer: Issuer): XmlElement {
  return element('emit', [
    leaf('CNPJ', assertValidCnpj(issuer.cnpj)),
    leaf('xNome', fiscalText('emit/xNome', issuer.legalName)),
    optionalLeaf('xFant', optionalFiscalText('emit/xFant', issuer.tradeName)),
    buildAddress('enderEmit', issuer.address, 'emit'),
    leaf('IE', codeValue('emit/IE', issuer.stateRegistration, STATE_REGISTRATION)),
    ...municipalRegistrationChildren(issuer),
    leaf('CRT', String(issuer.taxRegime)),
  ]);
}

export function buildDest(recipient: Recipient): XmlElement {
  const isContributor =
    recipient.stateRegistrationIndicator === StateRegistrationIndicator.Contributor;

  if (isContributor && recipient.stateRegistration === undefined) {
    throw new InvalidNfeDocumentError(
      'Destinatário contribuinte do ICMS (indIEDest = 1) precisa de inscrição estadual.',
    );
  }

  const documentLeaf =
    recipient.document.type === 'CNPJ'
      ? leaf('CNPJ', assertValidCnpj(recipient.document.value))
      : leaf('CPF', assertValidCpf(recipient.document.value));

  return element('dest', [
    documentLeaf,
    leaf('xNome', fiscalText('dest/xNome', recipient.name)),
    buildAddress('enderDest', recipient.address, 'dest'),
    leaf('indIEDest', String(recipient.stateRegistrationIndicator)),
    optionalLeaf('IE', optionalCodeValue('dest/IE', recipient.stateRegistration, STATE_REGISTRATION)),
    optionalLeaf('email', optionalFiscalText('dest/email', recipient.email)),
  ]);
}
