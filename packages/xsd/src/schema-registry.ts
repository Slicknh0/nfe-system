/**
 * Registro de pacotes de schema oficiais.
 *
 * Os XSDs não são gerados nem transcritos: são os arquivos publicados no Portal
 * Nacional da NF-e, versionados no repositório sob `schemas/`. Quando um novo
 * Pacote de Liberação sai, entra um novo diretório e uma nova entrada aqui — o
 * pacote anterior continua disponível, porque documentos históricos precisam
 * ser revalidáveis contra o schema vigente na época da emissão.
 */

export interface SchemaPackage {
  /** Identificador do Pacote de Liberação, como publicado pelo portal. */
  readonly id: string;
  /** Versão do leiaute que este pacote atende. */
  readonly layoutVersion: string;
  /** Diretório, relativo à raiz do repositório, com os `.xsd`. */
  readonly directory: string;
  /** Arquivo raiz para validação de NF-e. */
  readonly rootSchema: string;
  /** Data de publicação informada pelo portal. */
  readonly publishedAt: string;
  /** Notas Técnicas contempladas. */
  readonly technicalNotes: readonly string[];
  /**
   * Raiz montada em memória, quando o pacote oficial publica o tipo do
   * documento mas não um arquivo raiz que o declare como elemento global.
   */
  readonly syntheticRoot?: string;
}

/**
 * Pacote corrente.
 *
 * Origem: Portal Nacional da NF-e, seção "Esquemas XML".
 * Baixado em 2026-09-10; conteúdo não modificado.
 */
export const PL_010F: SchemaPackage = Object.freeze({
  id: 'PL_010f_v1.04',
  layoutVersion: '4.00',
  directory: 'schemas/nfe/PL_010f_v1.04',
  rootSchema: 'nfe_v4.00.xsd',
  publishedAt: '2026-08-31',
  technicalNotes: Object.freeze(['NT 2025.002 v.1.50', 'NT 2026.007 v.1.00']),
});

/**
 * Pedido de inutilização de numeração (`inutNFe`).
 *
 * O PL_010f não traz os schemas de inutilização. O pacote mais recente que os
 * publica é o PL_010d_v1.03 (CNPJ alfanumérico, NT 2026.004), versionado em
 * `schemas/nfe/PL_010d_v1.03/` sem modificação. Os `tiposBasico_v4.00.xsd`
 * e `xmldsig-core-schema_v1.01.xsd` dos dois pacotes são idênticos byte a byte.
 *
 * Nenhum pacote 010 publica `inutNFe_v4.00.xsd`, a raiz citada no MOC 7.0
 * (Visão Geral, 5.3.1): o leiaute declara o tipo `TInutNFe` e só o usa dentro
 * de `ProcInutNFe`. A raiz abaixo apenas declara o elemento `inutNFe` com esse
 * tipo oficial — nenhuma regra é acrescentada ou alterada.
 */
export const PL_010D_INUTILIZATION: SchemaPackage = Object.freeze({
  id: 'PL_010d_v1.03',
  layoutVersion: '4.00',
  directory: 'schemas/nfe/PL_010d_v1.03/NFe',
  rootSchema: 'inutNFe_v4.00.xsd',
  publishedAt: '2026-07-10',
  technicalNotes: Object.freeze(['NT 2026.004 v.1.01']),
  syntheticRoot:
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns="http://www.portalfiscal.inf.br/nfe" ' +
    'targetNamespace="http://www.portalfiscal.inf.br/nfe" elementFormDefault="qualified" attributeFormDefault="unqualified">' +
    '<xs:include schemaLocation="leiauteInutNFe_v4.00.xsd"/>' +
    '<xs:element name="inutNFe" type="TInutNFe"/>' +
    '</xs:schema>',
});

export const SCHEMA_PACKAGES: readonly SchemaPackage[] = Object.freeze([
  PL_010F,
  PL_010D_INUTILIZATION,
]);

/** Pacote usado quando a emissão não fixa versão explícita. */
export const DEFAULT_SCHEMA_PACKAGE = PL_010F;

export function findSchemaPackage(id: string): SchemaPackage | undefined {
  return SCHEMA_PACKAGES.find((pkg) => pkg.id === id);
}
