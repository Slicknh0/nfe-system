/**
 * Catálogo dos web services da SEFAZ-SP, NF-e versão 4.00.
 *
 * URLs: página oficial da SEFAZ-SP
 * (portal.fazenda.sp.gov.br/servicos/nfe/Paginas/URL-WEBSERVICES.aspx).
 *
 * Operação e método SOAP vêm do WSDL de cada serviço, que só é entregue com
 * autenticação mútua — sem certificado a SEFAZ responde HTTP 403. Os nomes
 * abaixo são os da implementação de referência sped-nfe
 * (storage/wsnfe_4.00_mod55.xml) e precisam ser conferidos contra o `?wsdl`,
 * com o certificado A1, antes da primeira transmissão em produção.
 *
 * Namespace e ação seguem o padrão do MOC 7.0 (Visão Geral, 4.2.2 e 4.4):
 * SOAP 1.2, mensagem em `nfeDadosMsg`, sem variáveis no SOAP Header na 4.00.
 */

import { Environment } from '@nfe/core';
import type { EnvironmentCode } from '../provider.js';

export const PORTAL_NAMESPACE = 'http://www.portalfiscal.inf.br/nfe';

export type SefazService = 'AUTHORIZATION' | 'PROTOCOL_QUERY' | 'NUMBER_VOID';

export interface ServiceEndpoint {
  readonly url: string;
  /** Nome da operação no WSDL; compõe o namespace. */
  readonly operation: string;
  /** Método SOAP; compõe a ação. */
  readonly method: string;
}

export type EndpointCatalog = Readonly<Record<SefazService, ServiceEndpoint>>;

function sefazSp(host: string): EndpointCatalog {
  return Object.freeze({
    AUTHORIZATION: {
      url: `https://${host}/ws/nfeautorizacao4.asmx`,
      operation: 'NFeAutorizacao4',
      method: 'nfeAutorizacaoLote',
    },
    PROTOCOL_QUERY: {
      url: `https://${host}/ws/nfeconsultaprotocolo4.asmx`,
      operation: 'NFeConsultaProtocolo4',
      method: 'nfeConsultaNF',
    },
    NUMBER_VOID: {
      url: `https://${host}/ws/nfeinutilizacao4.asmx`,
      operation: 'NFeInutilizacao4',
      method: 'nfeInutilizacaoNF',
    },
  });
}

export const SEFAZ_SP_ENDPOINTS: Readonly<Record<EnvironmentCode, EndpointCatalog>> = Object.freeze({
  [Environment.Production]: sefazSp('nfe.fazenda.sp.gov.br'),
  [Environment.Homologation]: sefazSp('homologacao.nfe.fazenda.sp.gov.br'),
});

export function soapNamespace(endpoint: ServiceEndpoint): string {
  return `${PORTAL_NAMESPACE}/wsdl/${endpoint.operation}`;
}

export function soapAction(endpoint: ServiceEndpoint): string {
  return `${soapNamespace(endpoint)}/${endpoint.method}`;
}
