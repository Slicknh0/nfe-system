/**
 * Leitura das respostas SOAP da SEFAZ.
 *
 * A estrutura esperada é a dos tipos oficiais: `TRetEnviNFe` (leiauteNFe),
 * `TRetConsSitNFe` (leiauteConsSitNFe) e `TRetInutNFe` (leiauteInutNFe). O
 * elemento que envolve o retorno dentro do SOAP Body não é fixado — só o
 * retorno em si, no namespace do Portal.
 *
 * Qualquer coisa fora do esperado — XML malformado, SOAP Fault, campo
 * obrigatório ausente, ambiente diferente do pedido — vira erro, e o chamador
 * trata como desfecho desconhecido. Nunca se presume autorização a partir de
 * uma resposta que não foi entendida por inteiro.
 */

import { XmlC14NMode, XmlDocument, XmlElement } from 'libxml2-wasm';
import type { EnvironmentCode, InvoiceProtocol, StatusReply } from '../provider.js';
import type {
  AuthorizationResponse,
  NumberVoidResponse,
  ProtocolQueryResponse,
} from '../status-codes.js';
import { PORTAL_NAMESPACE } from './endpoints.js';
import { SOAP_12_NAMESPACE } from './envelope.js';

const NAMESPACES = { nfe: PORTAL_NAMESPACE, soap: SOAP_12_NAMESPACE };
const BODY = '/soap:Envelope/soap:Body';
const STATUS_CODE = /^[0-9]{3,4}$/;
const MAX_FAULT_REASON = 500;

export class SefazResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SefazResponseError';
  }
}

export class SoapFaultError extends Error {
  constructor(readonly faultReason: string) {
    super(`A SEFAZ devolveu SOAP Fault: ${faultReason}`);
    this.name = 'SoapFaultError';
  }
}

function withDocument<T>(xml: string, read: (document: XmlDocument) => T): T {
  let document: XmlDocument;
  try {
    document = XmlDocument.fromString(xml);
  } catch {
    throw new SefazResponseError('A resposta da SEFAZ não é XML bem formado.');
  }
  try {
    return read(document);
  } finally {
    document.dispose();
  }
}

function elementAt(document: XmlDocument, xpath: string): XmlElement | undefined {
  const node = document.get(xpath, NAMESPACES);
  return node instanceof XmlElement ? node : undefined;
}

function optionalText(document: XmlDocument, xpath: string): string | undefined {
  const value = elementAt(document, xpath)?.content.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function requiredText(document: XmlDocument, xpath: string, field: string): string {
  const value = optionalText(document, xpath);
  if (value === undefined) {
    throw new SefazResponseError(`A resposta da SEFAZ não traz ${field}.`);
  }
  return value;
}

function statusAt(document: XmlDocument, base: string): StatusReply {
  const code = requiredText(document, `${base}/nfe:cStat`, 'cStat');
  if (!STATUS_CODE.test(code)) {
    throw new SefazResponseError(`cStat fora do formato: ${code.slice(0, 10)}.`);
  }
  return {
    statusCode: Number(code),
    statusReason: requiredText(document, `${base}/nfe:xMotivo`, 'xMotivo'),
  };
}

function dateAt(document: XmlDocument, xpath: string, field: string): Date {
  const value = requiredText(document, xpath, field);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new SefazResponseError(`${field} fora do formato de data e hora.`);
  }
  return date;
}

function assertEnvironment(document: XmlDocument, base: string, environment: EnvironmentCode): void {
  const tpAmb = requiredText(document, `${base}/nfe:tpAmb`, 'tpAmb');
  if (tpAmb !== String(environment)) {
    throw new SefazResponseError(
      `A SEFAZ respondeu para o ambiente ${tpAmb.slice(0, 2)}, mas a requisição foi para o ambiente ${environment}.`,
    );
  }
}

/** C14N exclusiva: o trecho sai sem os namespaces do envelope SOAP. */
function canonicalAt(document: XmlDocument, xpath: string): string | undefined {
  return elementAt(document, xpath)?.canonicalizeToString({ mode: XmlC14NMode.XML_C14N_EXCLUSIVE_1_0 });
}

function locateResult(document: XmlDocument, root: string): string {
  if (elementAt(document, `${BODY}/soap:Fault`) !== undefined) {
    const reason = optionalText(document, `${BODY}/soap:Fault/soap:Reason/soap:Text`) ?? 'sem descrição';
    throw new SoapFaultError(reason.slice(0, MAX_FAULT_REASON));
  }
  const base = `${BODY}/*/nfe:${root}`;
  if (elementAt(document, base) === undefined) {
    throw new SefazResponseError(`A resposta da SEFAZ não traz o elemento ${root}.`);
  }
  return base;
}

/** Motivo de um SOAP Fault, quando a resposta for um; `undefined` em qualquer outro caso. */
export function readSoapFault(xml: string): string | undefined {
  try {
    return withDocument(xml, (document) =>
      elementAt(document, `${BODY}/soap:Fault`) === undefined
        ? undefined
        : (optionalText(document, `${BODY}/soap:Fault/soap:Reason/soap:Text`) ?? 'sem descrição').slice(
            0,
            MAX_FAULT_REASON,
          ),
    );
  } catch {
    return undefined;
  }
}

function protocolAt(
  document: XmlDocument,
  protNFe: string,
  environment: EnvironmentCode,
): { protocol?: InvoiceProtocol; protocolStatus?: StatusReply } {
  const infProt = `${protNFe}/nfe:infProt`;
  if (elementAt(document, infProt) === undefined) {
    return {};
  }
  assertEnvironment(document, infProt, environment);
  const status = statusAt(document, infProt);
  const protocolNumber = optionalText(document, `${infProt}/nfe:nProt`);
  if (protocolNumber === undefined) {
    return { protocolStatus: status };
  }
  const digestValue = optionalText(document, `${infProt}/nfe:digVal`);
  const xml = canonicalAt(document, protNFe);
  return {
    protocol: {
      accessKey: requiredText(document, `${infProt}/nfe:chNFe`, 'chNFe'),
      ...status,
      protocolNumber,
      receivedAt: dateAt(document, `${infProt}/nfe:dhRecbto`, 'dhRecbto'),
      ...(digestValue === undefined ? {} : { digestValue }),
      ...(xml === undefined ? {} : { xml }),
    },
  };
}

/** `nfeAutorizacaoLote` — `retEnviNFe`. */
export function readAuthorizationResponse(xml: string, environment: EnvironmentCode): AuthorizationResponse {
  return withDocument(xml, (document) => {
    const base = locateResult(document, 'retEnviNFe');
    assertEnvironment(document, base, environment);
    return { batch: statusAt(document, base), ...protocolAt(document, `${base}/nfe:protNFe`, environment) };
  });
}

/** `nfeConsultaNF` — `retConsSitNFe`. */
export function readProtocolQueryResponse(xml: string, environment: EnvironmentCode): ProtocolQueryResponse {
  return withDocument(xml, (document) => {
    const base = locateResult(document, 'retConsSitNFe');
    assertEnvironment(document, base, environment);
    const { protocol } = protocolAt(document, `${base}/nfe:protNFe`, environment);
    return { status: statusAt(document, base), ...(protocol === undefined ? {} : { protocol }) };
  });
}

/** `nfeInutilizacaoNF` — `retInutNFe`. */
export function readNumberVoidResponse(xml: string, environment: EnvironmentCode): NumberVoidResponse {
  return withDocument(xml, (document) => {
    const root = locateResult(document, 'retInutNFe');
    const base = `${root}/nfe:infInut`;
    if (elementAt(document, base) === undefined) {
      throw new SefazResponseError('A resposta da SEFAZ não traz infInut.');
    }
    assertEnvironment(document, base, environment);
    const protocolNumber = optionalText(document, `${base}/nfe:nProt`);
    const receivedAt = optionalText(document, `${base}/nfe:dhRecbto`);
    const responseXml = canonicalAt(document, root);
    return {
      status: statusAt(document, base),
      ...(protocolNumber === undefined ? {} : { protocolNumber }),
      ...(receivedAt === undefined ? {} : { receivedAt: dateAt(document, `${base}/nfe:dhRecbto`, 'dhRecbto') }),
      ...(responseXml === undefined ? {} : { xml: responseXml }),
    };
  });
}
