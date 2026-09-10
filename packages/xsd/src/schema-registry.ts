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

export const SCHEMA_PACKAGES: readonly SchemaPackage[] = Object.freeze([PL_010F]);

/** Pacote usado quando a emissão não fixa versão explícita. */
export const DEFAULT_SCHEMA_PACKAGE = PL_010F;

export function findSchemaPackage(id: string): SchemaPackage | undefined {
  return SCHEMA_PACKAGES.find((pkg) => pkg.id === id);
}
