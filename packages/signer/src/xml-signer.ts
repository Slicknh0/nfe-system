/**
 * Assinatura digital XML da NF-e (XML-DSig envelopada).
 *
 * Algoritmos fixados pelo `xmldsig-core-schema_v1.01.xsd` do PL_010f_v1.04 — o
 * schema declara cada um com `fixed`, então não há escolha a fazer:
 *
 * - canonicalização: C14N 1.0 inclusiva (`REC-xml-c14n-20010315`);
 * - assinatura: RSA-SHA1;
 * - digest: SHA1;
 * - exatamente dois `Transform`: `enveloped-signature` e C14N;
 * - uma única `Reference`, e `KeyInfo` contendo somente `X509Certificate`.
 *
 * Decisão arquitetural: canonicalização feita pelo libxml2 — o mesmo parser do
 * validador de schema — e criptografia por `node:crypto`. Uma biblioteca de
 * XML-DSig genérica traria flexibilidade de algoritmos que o schema proíbe e um
 * segundo parser XML cuja canonicalização poderia divergir sutilmente. Nos
 * testes, uma implementação independente (`xml-crypto`) verifica as assinaturas
 * produzidas aqui.
 *
 * A assinatura cobre `infNFe`. `Signature` é inserida como último filho de
 * `NFe`, irmã de `infNFe`, então o transform `enveloped-signature` não remove
 * nada do conteúdo assinado — e o conteúdo fiscal sai byte a byte idêntico ao
 * de entrada.
 */

import {
  X509Certificate,
  createHash,
  createPrivateKey,
  createSign,
  createVerify,
  type KeyObject,
} from 'node:crypto';
import { XmlC14NMode, XmlDocument, XmlElement } from 'libxml2-wasm';
import { XmlSignatureError } from './errors.js';

export const SIGNATURE_ALGORITHMS = Object.freeze({
  canonicalization: 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315',
  signature: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
  digest: 'http://www.w3.org/2000/09/xmldsig#sha1',
  envelopedSignature: 'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
});

const XMLDSIG_NAMESPACE = 'http://www.w3.org/2000/09/xmldsig#';
const NAMESPACES = {
  nfe: 'http://www.portalfiscal.inf.br/nfe',
  ds: XMLDSIG_NAMESPACE,
};

/** Atributo `Id` de `infNFe`: prefixo `NFe` e o pattern de `TChNFe`. */
const INF_NFE_ID = /^NFe[0-9]{6}[0-9A-Z]{12}[0-9]{26}$/;
const ROOT_CLOSING_TAG = '</NFe>';
const CANONICAL = { mode: XmlC14NMode.XML_C14N_1_0 };

const SIGNATURE_PATH = '/nfe:NFe/ds:Signature';
const SIGNED_INFO_PATH = `${SIGNATURE_PATH}/ds:SignedInfo`;
const REFERENCE_PATH = `${SIGNED_INFO_PATH}/ds:Reference`;

export interface SigningCredentials {
  readonly privateKeyPem: string;
  readonly certificatePem: string;
}

export interface SignOptions {
  /** Instante usado para conferir a validade do certificado. Padrão: agora. */
  readonly now?: Date;
}

interface LoadedCredentials {
  readonly privateKey: KeyObject;
  readonly certificate: X509Certificate;
}

function loadCredentials(credentials: SigningCredentials, now: Date): LoadedCredentials {
  let privateKey: KeyObject;
  let certificate: X509Certificate;
  try {
    privateKey = createPrivateKey(credentials.privateKeyPem);
    certificate = new X509Certificate(credentials.certificatePem);
  } catch (error) {
    throw new XmlSignatureError(
      'INVALID_CREDENTIALS',
      'Chave privada ou certificado ilegível.',
      { cause: error },
    );
  }

  if (!certificate.checkPrivateKey(privateKey)) {
    throw new XmlSignatureError(
      'KEY_CERTIFICATE_MISMATCH',
      'A chave privada não corresponde ao certificado informado.',
    );
  }

  if (now < new Date(certificate.validFrom)) {
    throw new XmlSignatureError(
      'CERTIFICATE_NOT_YET_VALID',
      `Certificado ainda não é válido; início da validade em ${certificate.validFrom}.`,
    );
  }

  if (now > new Date(certificate.validTo)) {
    throw new XmlSignatureError(
      'CERTIFICATE_EXPIRED',
      `Certificado vencido em ${certificate.validTo}.`,
    );
  }

  return { privateKey, certificate };
}

function withDocument<T>(xml: string, action: (document: XmlDocument) => T): T {
  let document: XmlDocument;
  try {
    document = XmlDocument.fromString(xml);
  } catch (error) {
    throw new XmlSignatureError('DOCUMENT_NOT_SIGNABLE', 'XML malformado.', { cause: error });
  }

  try {
    return action(document);
  } finally {
    document.dispose();
  }
}

function findElement(document: XmlDocument, xpath: string): XmlElement | null {
  const node = document.get(xpath, NAMESPACES);
  return node instanceof XmlElement ? node : null;
}

function sha1Base64(content: string): string {
  return createHash('sha1').update(content, 'utf8').digest('base64');
}

/**
 * Estrutura de `Signature`, elemento a elemento como no schema.
 *
 * É montada por template porque todo valor interpolado tem alfabeto restrito e
 * já validado — `Id` pelo pattern de `TChNFe`, os demais em base64 produzido
 * aqui mesmo — e nenhum precisa de escape. A forma canônica usada no cálculo é
 * extraída pelo libxml2 do documento real, e não deste texto.
 */
function signatureMarkup(
  referenceId: string,
  digestValue: string,
  signatureValue: string,
  certificateValue: string,
): string {
  return (
    `<Signature xmlns="${XMLDSIG_NAMESPACE}">` +
    `<SignedInfo>` +
    `<CanonicalizationMethod Algorithm="${SIGNATURE_ALGORITHMS.canonicalization}"/>` +
    `<SignatureMethod Algorithm="${SIGNATURE_ALGORITHMS.signature}"/>` +
    `<Reference URI="#${referenceId}">` +
    `<Transforms>` +
    `<Transform Algorithm="${SIGNATURE_ALGORITHMS.envelopedSignature}"/>` +
    `<Transform Algorithm="${SIGNATURE_ALGORITHMS.canonicalization}"/>` +
    `</Transforms>` +
    `<DigestMethod Algorithm="${SIGNATURE_ALGORITHMS.digest}"/>` +
    `<DigestValue>${digestValue}</DigestValue>` +
    `</Reference>` +
    `</SignedInfo>` +
    `<SignatureValue>${signatureValue}</SignatureValue>` +
    `<KeyInfo><X509Data><X509Certificate>${certificateValue}</X509Certificate></X509Data></KeyInfo>` +
    `</Signature>`
  );
}

function insertSignature(xml: string, markup: string): string {
  const index = xml.lastIndexOf(ROOT_CLOSING_TAG);
  if (index < 0 || xml.slice(index + ROOT_CLOSING_TAG.length).trim() !== '') {
    throw new XmlSignatureError(
      'DOCUMENT_NOT_SIGNABLE',
      'Documento não termina no fechamento do elemento raiz NFe.',
    );
  }
  return xml.slice(0, index) + markup + xml.slice(index);
}

interface SignableContent {
  readonly referenceId: string;
  readonly digestValue: string;
}

function readSignableContent(document: XmlDocument): SignableContent {
  if (findElement(document, SIGNATURE_PATH) !== null) {
    throw new XmlSignatureError('ALREADY_SIGNED', 'O documento já contém assinatura.');
  }

  const infNFe = findElement(document, '/nfe:NFe/nfe:infNFe');
  if (infNFe === null) {
    throw new XmlSignatureError(
      'DOCUMENT_NOT_SIGNABLE',
      'Elemento infNFe não encontrado sob NFe no namespace da NF-e.',
    );
  }

  const referenceId = infNFe.attr('Id')?.value;
  if (referenceId === undefined || !INF_NFE_ID.test(referenceId)) {
    throw new XmlSignatureError(
      'DOCUMENT_NOT_SIGNABLE',
      'Atributo Id de infNFe ausente ou fora do formato NFe + chave de acesso.',
    );
  }

  return { referenceId, digestValue: sha1Base64(infNFe.canonicalizeToString(CANONICAL)) };
}

export function signNfeXml(
  unsignedXml: string,
  credentials: SigningCredentials,
  options: SignOptions = {},
): string {
  const { privateKey, certificate } = loadCredentials(credentials, options.now ?? new Date());
  const { referenceId, digestValue } = withDocument(unsignedXml, readSignableContent);
  const certificateValue = certificate.raw.toString('base64');

  // SignedInfo é canonicalizado dentro do documento final, para herdar exatamente
  // os namespaces em escopo que o verificador vai enxergar.
  const draft = insertSignature(
    unsignedXml,
    signatureMarkup(referenceId, digestValue, '', certificateValue),
  );

  const signatureValue = withDocument(draft, (document) => {
    const signedInfo = findElement(document, SIGNED_INFO_PATH);
    if (signedInfo === null) {
      throw new XmlSignatureError('DOCUMENT_NOT_SIGNABLE', 'Falha ao localizar SignedInfo.');
    }
    return createSign('RSA-SHA1')
      .update(signedInfo.canonicalizeToString(CANONICAL), 'utf8')
      .sign(privateKey, 'base64');
  });

  return insertSignature(
    unsignedXml,
    signatureMarkup(referenceId, digestValue, signatureValue, certificateValue),
  );
}

export type SignatureVerification =
  | { readonly valid: true; readonly certificate: X509Certificate }
  | { readonly valid: false; readonly reason: string };

const invalid = (reason: string): SignatureVerification => ({ valid: false, reason });

function textContent(node: XmlElement | null): string {
  return (node?.content ?? '').replace(/\s+/g, '');
}

const ALGORITHM_CHECKS: readonly (readonly [string, string])[] = [
  [`${SIGNED_INFO_PATH}/ds:CanonicalizationMethod`, SIGNATURE_ALGORITHMS.canonicalization],
  [`${SIGNED_INFO_PATH}/ds:SignatureMethod`, SIGNATURE_ALGORITHMS.signature],
  [`${REFERENCE_PATH}/ds:DigestMethod`, SIGNATURE_ALGORITHMS.digest],
];

const EXPECTED_TRANSFORMS = [
  SIGNATURE_ALGORITHMS.envelopedSignature,
  SIGNATURE_ALGORITHMS.canonicalization,
];

/**
 * Verifica integridade e autoria criptográfica da assinatura.
 *
 * Não valida a cadeia do certificado até a AC raiz da ICP-Brasil nem consulta
 * revogação — isso é responsabilidade do módulo de certificados.
 */
export function verifyNfeSignature(signedXml: string): SignatureVerification {
  return withDocument(signedXml, (document) => {
    const infNFe = findElement(document, '/nfe:NFe/nfe:infNFe');
    const signedInfo = findElement(document, SIGNED_INFO_PATH);
    const reference = findElement(document, REFERENCE_PATH);
    if (infNFe === null || signedInfo === null || reference === null) {
      return invalid('Estrutura de assinatura ausente ou incompleta.');
    }

    for (const [xpath, expected] of ALGORITHM_CHECKS) {
      if (findElement(document, xpath)?.attr('Algorithm')?.value !== expected) {
        return invalid(`Algoritmo diferente do fixado pelo schema em ${xpath}.`);
      }
    }

    const transforms = document
      .find(`${REFERENCE_PATH}/ds:Transforms/ds:Transform`, NAMESPACES)
      .map((node) => (node instanceof XmlElement ? node.attr('Algorithm')?.value : undefined));
    if (
      transforms.length !== EXPECTED_TRANSFORMS.length ||
      transforms.some((algorithm, index) => algorithm !== EXPECTED_TRANSFORMS[index])
    ) {
      return invalid('Transforms diferentes dos fixados pelo schema.');
    }

    const referenceId = infNFe.attr('Id')?.value;
    if (referenceId === undefined || reference.attr('URI')?.value !== `#${referenceId}`) {
      return invalid('A Reference não aponta para o Id de infNFe.');
    }

    const digestValue = textContent(findElement(document, `${REFERENCE_PATH}/ds:DigestValue`));
    if (sha1Base64(infNFe.canonicalizeToString(CANONICAL)) !== digestValue) {
      return invalid('DigestValue não confere: o conteúdo de infNFe foi alterado após a assinatura.');
    }

    let certificate: X509Certificate;
    try {
      certificate = new X509Certificate(
        Buffer.from(
          textContent(findElement(document, `${SIGNATURE_PATH}/ds:KeyInfo/ds:X509Data/ds:X509Certificate`)),
          'base64',
        ),
      );
    } catch {
      return invalid('Certificado de KeyInfo ilegível.');
    }

    const signatureValue = textContent(findElement(document, `${SIGNATURE_PATH}/ds:SignatureValue`));
    const matches = createVerify('RSA-SHA1')
      .update(signedInfo.canonicalizeToString(CANONICAL), 'utf8')
      .verify(certificate.publicKey, signatureValue, 'base64');

    return matches
      ? { valid: true, certificate }
      : invalid('SignatureValue não confere com SignedInfo e o certificado informado.');
  });
}
