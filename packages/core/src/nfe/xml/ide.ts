/** Grupo `ide` — identificação da NF-e. */

import { NFE_MODEL } from '../../fiscal/access-key.js';
import { element, leaf, optionalLeaf, type XmlChild, type XmlElement } from '../../xml/element.js';
import { EmissionType, InvalidNfeDocumentError, type Identification } from '../document.js';
import { formatDateTime } from './format.js';
import { MUNICIPALITY_CODE, RANDOM_CODE } from './patterns.js';
import { codeValue, fiscalText } from './text.js';

/** `procEmi = 0`: emissão com aplicativo do próprio contribuinte. */
const PROCESS_OWN_APPLICATION = '0';

/**
 * `dhCont` e `xJust` acompanham toda emissão em contingência e não existem na
 * emissão normal. A coerência entre `tpEmis` e a presença desses campos é
 * verificada aqui, na montagem, e não descoberta na rejeição.
 */
function contingencyChildren(identification: Identification): XmlChild[] {
  const { contingency, emissionType, timeZone } = identification;
  const isNormal = emissionType === EmissionType.Normal;

  if (isNormal) {
    if (contingency !== undefined) {
      throw new InvalidNfeDocumentError(
        'Emissão normal (tpEmis = 1) não pode informar entrada em contingência.',
      );
    }
    return [];
  }

  if (contingency === undefined) {
    throw new InvalidNfeDocumentError(
      `Emissão em contingência (tpEmis = ${emissionType}) exige data de entrada e justificativa.`,
    );
  }

  return [
    leaf('dhCont', formatDateTime('ide/dhCont', contingency.enteredAt, timeZone)),
    leaf('xJust', fiscalText('ide/xJust', contingency.justification)),
  ];
}

export function buildIde(identification: Identification, accessKey: string): XmlElement {
  const intermediary =
    identification.intermediary === undefined ? undefined : String(identification.intermediary);

  return element('ide', [
    leaf('cUF', String(identification.stateCode)),
    leaf('cNF', codeValue('ide/cNF', identification.randomCode, RANDOM_CODE)),
    leaf('natOp', fiscalText('ide/natOp', identification.operationNature)),
    leaf('mod', String(NFE_MODEL)),
    leaf('serie', String(identification.series)),
    leaf('nNF', String(identification.number)),
    leaf('dhEmi', formatDateTime('ide/dhEmi', identification.issuedAt, identification.timeZone)),
    leaf('tpNF', String(identification.operationType)),
    leaf('idDest', String(identification.destinationScope)),
    leaf('cMunFG', codeValue('ide/cMunFG', identification.municipalityCode, MUNICIPALITY_CODE)),
    leaf('tpImp', String(identification.printFormat)),
    leaf('tpEmis', String(identification.emissionType)),
    leaf('cDV', accessKey.slice(-1)),
    leaf('tpAmb', String(identification.environment)),
    leaf('finNFe', String(identification.purpose)),
    leaf('indFinal', String(identification.finalConsumer)),
    leaf('indPres', String(identification.buyerPresence)),
    optionalLeaf('indIntermed', intermediary),
    leaf('procEmi', PROCESS_OWN_APPLICATION),
    leaf('verProc', fiscalText('ide/verProc', identification.applicationVersion)),
    ...contingencyChildren(identification),
  ]);
}
