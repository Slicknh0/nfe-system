/**
 * Campos específicos dos certificados ICP-Brasil.
 *
 * O CNPJ da pessoa jurídica titular fica na extensão Subject Alternative Name,
 * campo `otherName` com OID 2.16.76.1.3.3 (DOC-ICP-04). O MOC 7.0 (Visão Geral,
 * 4.2.3) exige esse CNPJ nos certificados usados na NF-e.
 */

import { isValidCnpj, normalizeCnpj } from '@nfe/core';
import forge from 'node-forge';

export const ICP_BRASIL_CNPJ_OID = '2.16.76.1.3.3';

const SUBJECT_ALT_NAME_OID = '2.5.29.17';
const OTHER_NAME_TAG = 0;
const CONTEXT_SPECIFIC_CLASS = Number(forge.asn1.Class.CONTEXT_SPECIFIC);

interface RawExtension {
  readonly id?: string;
  readonly value?: unknown;
}

/** CNPJ do titular, lido do `otherName` 2.16.76.1.3.3. `undefined` quando ausente ou inválido. */
export function extractIcpBrasilCnpj(certificate: forge.pki.Certificate): string | undefined {
  const extension = (certificate.extensions as RawExtension[]).find(
    (candidate) => candidate.id === SUBJECT_ALT_NAME_OID,
  );
  if (typeof extension?.value !== 'string') {
    return undefined;
  }

  let names: forge.asn1.Asn1;
  try {
    names = forge.asn1.fromDer(extension.value);
  } catch {
    return undefined;
  }
  if (!Array.isArray(names.value)) {
    return undefined;
  }

  for (const name of names.value) {
    if (
      Number(name.tagClass) !== CONTEXT_SPECIFIC_CLASS ||
      Number(name.type) !== OTHER_NAME_TAG ||
      !Array.isArray(name.value)
    ) {
      continue;
    }
    const [oid, wrapped] = name.value;
    if (typeof oid?.value !== 'string' || forge.asn1.derToOid(oid.value) !== ICP_BRASIL_CNPJ_OID) {
      continue;
    }
    const inner = Array.isArray(wrapped?.value) ? wrapped.value[0] : undefined;
    if (typeof inner?.value !== 'string') {
      continue;
    }
    const cnpj = normalizeCnpj(inner.value);
    if (isValidCnpj(cnpj)) {
      return cnpj;
    }
  }
  return undefined;
}
