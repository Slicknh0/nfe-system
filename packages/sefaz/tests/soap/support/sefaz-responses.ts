/**
 * Retornos da SEFAZ montados pelos tipos oficiais, para testes.
 *
 * Cada construtor segue a ordem e a obrigatoriedade de `TRetEnviNFe`,
 * `TRetConsSitNFe` e `TRetInutNFe`, e os testes validam os XML gerados contra o
 * XSD oficial antes de usá-los — o parser é testado contra respostas conformes
 * ao leiaute, não contra um formato imaginado. Textos, versões de aplicativo e
 * números de protocolo são fictícios.
 */

import { PL_010D_INUTILIZATION, PL_010F, type SchemaPackage } from '@nfe/xsd';

const NFE_NAMESPACE = 'http://www.portalfiscal.inf.br/nfe';
export const RECEIVED_AT = '2026-09-12T15:00:00-03:00';
const APPLICATION = 'SP_TESTE_4.00';

export interface ProtocolFixture {
  readonly accessKey: string;
  readonly statusCode: number;
  readonly statusReason: string;
  /** Sem número, o protocolo é de rejeição. */
  readonly protocolNumber?: string;
  readonly environment?: number;
}

export function protNFe(protocol: ProtocolFixture): string {
  const environment = protocol.environment ?? 2;
  const numbered =
    protocol.protocolNumber === undefined
      ? ''
      : `<nProt>${protocol.protocolNumber}</nProt><digVal>ZGlnZXN0LWRhLW5vdGEtZGUtdGVzdGU=</digVal>`;
  return (
    `<protNFe versao="4.00"><infProt Id="ID${protocol.protocolNumber ?? '000000000000000'}">` +
    `<tpAmb>${environment}</tpAmb><verAplic>${APPLICATION}</verAplic><chNFe>${protocol.accessKey}</chNFe>` +
    `<dhRecbto>${RECEIVED_AT}</dhRecbto>${numbered}` +
    `<cStat>${protocol.statusCode}</cStat><xMotivo>${protocol.statusReason}</xMotivo></infProt></protNFe>`
  );
}

export interface RetEnviNFeFixture {
  readonly environment?: number;
  readonly statusCode: number;
  readonly statusReason: string;
  readonly protocol?: ProtocolFixture;
}

export function retEnviNFe(fixture: RetEnviNFeFixture): string {
  return (
    `<retEnviNFe xmlns="${NFE_NAMESPACE}" versao="4.00">` +
    `<tpAmb>${fixture.environment ?? 2}</tpAmb><verAplic>${APPLICATION}</verAplic>` +
    `<cStat>${fixture.statusCode}</cStat><xMotivo>${fixture.statusReason}</xMotivo>` +
    `<cUF>35</cUF><dhRecbto>${RECEIVED_AT}</dhRecbto>` +
    `${fixture.protocol === undefined ? '' : protNFe(fixture.protocol)}</retEnviNFe>`
  );
}

export interface RetConsSitNFeFixture {
  readonly environment?: number;
  readonly statusCode: number;
  readonly statusReason: string;
  readonly accessKey: string;
  readonly protocol?: ProtocolFixture;
}

export function retConsSitNFe(fixture: RetConsSitNFeFixture): string {
  return (
    `<retConsSitNFe xmlns="${NFE_NAMESPACE}" versao="4.00">` +
    `<tpAmb>${fixture.environment ?? 2}</tpAmb><verAplic>${APPLICATION}</verAplic>` +
    `<cStat>${fixture.statusCode}</cStat><xMotivo>${fixture.statusReason}</xMotivo>` +
    `<cUF>35</cUF><dhRecbto>${RECEIVED_AT}</dhRecbto><chNFe>${fixture.accessKey}</chNFe>` +
    `${fixture.protocol === undefined ? '' : protNFe(fixture.protocol)}</retConsSitNFe>`
  );
}

export interface RetInutNFeFixture {
  readonly environment?: number;
  readonly statusCode: number;
  readonly statusReason: string;
  readonly cnpj: string;
  readonly series: number;
  readonly number: number;
  /** Presente na homologação (102). */
  readonly protocolNumber?: string;
}

export function retInutNFe(fixture: RetInutNFeFixture): string {
  const homologated =
    fixture.protocolNumber === undefined
      ? ''
      : `<ano>26</ano><CNPJ>${fixture.cnpj}</CNPJ><mod>55</mod><serie>${fixture.series}</serie>` +
        `<nNFIni>${fixture.number}</nNFIni><nNFFin>${fixture.number}</nNFFin>`;
  return (
    `<retInutNFe xmlns="${NFE_NAMESPACE}" versao="4.00"><infInut>` +
    `<tpAmb>${fixture.environment ?? 2}</tpAmb><verAplic>${APPLICATION}</verAplic>` +
    `<cStat>${fixture.statusCode}</cStat><xMotivo>${fixture.statusReason}</xMotivo><cUF>35</cUF>` +
    `${homologated}<dhRecbto>${RECEIVED_AT}</dhRecbto>` +
    `${fixture.protocolNumber === undefined ? '' : `<nProt>${fixture.protocolNumber}</nProt>`}` +
    '</infInut></retInutNFe>'
  );
}

/** Raiz mínima que declara um elemento com um tipo oficial do leiaute. */
function rootFor(layout: string, element: string, type: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns="${NFE_NAMESPACE}" ` +
    `targetNamespace="${NFE_NAMESPACE}" elementFormDefault="qualified" attributeFormDefault="unqualified">` +
    `<xs:include schemaLocation="${layout}"/><xs:element name="${element}" type="${type}"/></xs:schema>`
  );
}

const { syntheticRoot: _inutilizationRoot, ...pl010dFiles } = PL_010D_INUTILIZATION;

export const SCHEMAS = Object.freeze({
  enviNFe: { ...PL_010F, rootSchema: 'enviNFe_v4.00.xsd', syntheticRoot: rootFor('leiauteNFe_v4.00.xsd', 'enviNFe', 'TEnviNFe') },
  retEnviNFe: {
    ...PL_010F,
    rootSchema: 'retEnviNFe_v4.00.xsd',
    syntheticRoot: rootFor('leiauteNFe_v4.00.xsd', 'retEnviNFe', 'TRetEnviNFe'),
  },
  /** Arquivos raiz oficiais do PL_010d_v1.03. */
  consSitNFe: { ...pl010dFiles, rootSchema: 'consSitNFe_v4.00.xsd' },
  retConsSitNFe: { ...pl010dFiles, rootSchema: 'retConsSitNFe_v4.00.xsd' },
  retInutNFe: {
    ...PL_010D_INUTILIZATION,
    rootSchema: 'retInutNFe_v4.00.xsd',
    syntheticRoot: rootFor('leiauteInutNFe_v4.00.xsd', 'retInutNFe', 'TRetInutNFe'),
  },
}) satisfies Readonly<Record<string, SchemaPackage>>;
