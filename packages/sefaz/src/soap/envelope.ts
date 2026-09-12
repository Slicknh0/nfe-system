/**
 * Envelope SOAP 1.2 das mensagens da NF-e (MOC 7.0, Visão Geral, 4.2.2).
 *
 * A área de dados vai em `nfeDadosMsg`, no namespace do serviço. Na versão
 * 4.00 não há mais `nfeCabecMsg` (4.4.1). O XML é inserido sem declaração: a
 * declaração só pode existir no início do documento.
 */

import { soapAction, soapNamespace, type ServiceEndpoint } from './endpoints.js';

export const SOAP_12_NAMESPACE = 'http://www.w3.org/2003/05/soap-envelope';

const XML_DECLARATION = /^\s*<\?xml[^?]*\?>\s*/;

export interface SoapRequest {
  readonly url: string;
  readonly contentType: string;
  readonly body: string;
}

export function stripXmlDeclaration(xml: string): string {
  return xml.replace(XML_DECLARATION, '');
}

export function buildSoapRequest(endpoint: ServiceEndpoint, payloadXml: string): SoapRequest {
  const payload = stripXmlDeclaration(payloadXml);
  if (!payload.startsWith('<')) {
    throw new Error('A mensagem para a SEFAZ precisa ser um documento XML.');
  }
  return {
    url: endpoint.url,
    contentType: `application/soap+xml; charset=utf-8; action="${soapAction(endpoint)}"`,
    body:
      '<?xml version="1.0" encoding="utf-8"?>' +
      `<soap12:Envelope xmlns:soap12="${SOAP_12_NAMESPACE}">` +
      '<soap12:Body>' +
      `<nfeDadosMsg xmlns="${soapNamespace(endpoint)}">${payload}</nfeDadosMsg>` +
      '</soap12:Body>' +
      '</soap12:Envelope>',
  };
}
