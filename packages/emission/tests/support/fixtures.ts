/**
 * Rascunhos de teste, assinador com certificado autoassinado em memória e
 * adaptador do validador de schema.
 *
 * Derivados do documento fictício de `@nfe/core`. Nenhuma credencial real.
 */

import type { NfeDocument } from '@nfe/core';
import { XmlSignatureError, signInutilizationXml, signNfeXml } from '@nfe/signer';
import { DEFAULT_SCHEMA_PACKAGE, PL_010D_INUTILIZATION, type NfeSchemaValidator } from '@nfe/xsd';
import { makeDocument } from '../../../core/tests/fixtures/nfe-document.js';
import {
  createTestCredentials,
  type TestCredentials,
} from '../../../signer/tests/support/credentials.js';
import {
  SigningRefusedError,
  type DraftDocument,
  type SchemaValidator,
  type XmlSigner,
} from '../../src/index.js';

export function toDraft(document: NfeDocument): DraftDocument {
  const { identification, ...rest } = document;
  const {
    number: _number,
    randomCode: _randomCode,
    issuedAt: _issuedAt,
    ...draftIdentification
  } = identification;
  return { ...rest, identification: draftIdentification };
}

export function makeDraft(overrides: Partial<NfeDocument> = {}): DraftDocument {
  return toDraft(makeDocument(overrides));
}

export function withIdentification(
  draft: DraftDocument,
  changes: Partial<DraftDocument['identification']>,
): DraftDocument {
  return { ...draft, identification: { ...draft.identification, ...changes } };
}

/** Adaptador de teste: traduz as recusas do `@nfe/signer` para a porta da aplicação. */
export function testSigner(credentials: TestCredentials = createTestCredentials()): XmlSigner {
  return {
    sign: ({ document, unsignedXml, now }) => {
      try {
        const sign = document === 'NFE' ? signNfeXml : signInutilizationXml;
        return Promise.resolve(sign(unsignedXml, credentials, { now }));
      } catch (error) {
        if (error instanceof XmlSignatureError) {
          return Promise.reject(new SigningRefusedError(error.reason, error.message));
        }
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}

/** Adaptador de teste: escolhe o pacote de schema oficial de cada documento. */
export function schemaValidatorFor(validator: NfeSchemaValidator): SchemaValidator {
  return {
    validate: (xml, document) =>
      validator.validate(xml, document === 'NFE' ? DEFAULT_SCHEMA_PACKAGE : PL_010D_INUTILIZATION),
  };
}
