/**
 * Validação de XML da NF-e contra os XSDs oficiais.
 *
 * Roda antes da assinatura e antes da transmissão. Rejeitar aqui é barato;
 * rejeitar na SEFAZ consome numeração, tempo e paciência do usuário.
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import {
  XmlDocument,
  XsdValidator,
  xmlRegisterInputProvider,
  type XmlDocument as XmlDocumentType,
} from 'libxml2-wasm';
import { DEFAULT_SCHEMA_PACKAGE, type SchemaPackage } from './schema-registry.js';
import { translateSchemaError, type TranslatedSchemaError } from './error-translation.js';

export class SchemaValidationFailure extends Error {
  constructor(readonly errors: readonly TranslatedSchemaError[]) {
    super(
      `XML reprovado na validação de schema (${errors.length} ` +
        `${errors.length === 1 ? 'ocorrência' : 'ocorrências'}).`,
    );
    this.name = 'SchemaValidationFailure';
  }
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly schemaPackageId: string;
  readonly errors: readonly TranslatedSchemaError[];
}

/**
 * O runtime WASM do libxml não enxerga o filesystem do host, então os
 * `xs:include` encadeados do leiaute precisam ser servidos por um provider.
 *
 * O provider registra o diretório sob o **id do pacote**, e os schemas são
 * carregados com URL `<packageId>/<arquivo>`. O libxml resolve os includes
 * relativos a essa URL, então cada include chega já carimbado com o pacote a
 * que pertence.
 *
 * Isso corrigiu um defeito encontrado na revisão: resolver apenas pelo
 * nome-base fazia dois pacotes que contêm `leiauteNFe_v4.00.xsd` colidirem —
 * vencia o que tivesse sido registrado primeiro. Como pacotes diferentes trazem
 * versões diferentes do mesmo arquivo, um documento histórico podia ser
 * validado contra o schema errado, exatamente o oposto do que o registro de
 * pacotes promete.
 *
 * A resolução continua confinada ao diretório do pacote: `basename` descarta
 * qualquer travessia embutida no `schemaLocation`.
 */
const schemaDirectoriesByPackage = new Map<string, string>();
const openHandles = new Map<number, { buffer: Buffer; position: number }>();
let nextHandleId = 1;
let providerRegistered = false;

function resolveSchemaFile(requested: string): string | undefined {
  const normalized = requested.replace(/\\/g, '/');
  const segments = normalized.split('/').filter((segment) => segment.length > 0);

  const fileName = segments.at(-1);
  const packageId = segments.at(-2);
  if (fileName === undefined || packageId === undefined) {
    return undefined;
  }

  const directory = schemaDirectoriesByPackage.get(packageId);
  if (directory === undefined) {
    return undefined;
  }

  const candidate = resolve(directory, basename(fileName));
  return existsSync(candidate) ? candidate : undefined;
}

function ensureProviderRegistered(): void {
  if (providerRegistered) {
    return;
  }

  xmlRegisterInputProvider({
    match: (filename: string) => resolveSchemaFile(filename) !== undefined,
    open: (filename: string) => {
      const path = resolveSchemaFile(filename);
      if (path === undefined) {
        return undefined;
      }
      const handleId = nextHandleId;
      nextHandleId += 1;
      openHandles.set(handleId, { buffer: readFileSync(path), position: 0 });
      return handleId;
    },
    read: (handleId: number, buffer: Uint8Array) => {
      const handle = openHandles.get(handleId);
      if (handle === undefined) {
        return 0;
      }
      const remaining = handle.buffer.length - handle.position;
      if (remaining <= 0) {
        return 0;
      }
      const length = Math.min(buffer.length, remaining);
      handle.buffer.copy(buffer, 0, handle.position, handle.position + length);
      handle.position += length;
      return length;
    },
    close: (handleId: number) => openHandles.delete(handleId),
  });

  providerRegistered = true;
}

interface LoadedValidator {
  readonly validator: XsdValidator;
  readonly schemaDoc: XmlDocumentType;
  readonly packageId: string;
}

/**
 * Compila e reaproveita validadores por pacote de schema.
 *
 * Compilar o leiaute completo é caro; fazer isso por documento derrubaria a
 * vazão de emissão em lote.
 */
export class NfeSchemaValidator {
  private readonly cache = new Map<string, LoadedValidator>();
  private readonly repositoryRoot: string;

  constructor(repositoryRoot: string) {
    this.repositoryRoot = resolve(repositoryRoot);
  }

  private load(schemaPackage: SchemaPackage): LoadedValidator {
    const cacheKey = `${schemaPackage.id}/${schemaPackage.rootSchema}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const directory = resolve(this.repositoryRoot, schemaPackage.directory);
    if (!existsSync(directory)) {
      throw new Error(
        `Diretório de schemas não encontrado: ${directory}. ` +
          `Verifique se o pacote ${schemaPackage.id} está versionado no repositório.`,
      );
    }

    schemaDirectoriesByPackage.set(schemaPackage.id, directory);
    ensureProviderRegistered();

    // A URL carimba o pacote, para que os includes relativos resolvam dentro dele.
    const url = cacheKey;
    const rootContent =
      schemaPackage.syntheticRoot === undefined
        ? readFileSync(resolve(directory, schemaPackage.rootSchema))
        : Buffer.from(schemaPackage.syntheticRoot, 'utf8');
    const schemaDoc = XmlDocument.fromBuffer(rootContent, { url });
    const validator = XsdValidator.fromDoc(schemaDoc);

    const loaded: LoadedValidator = { validator, schemaDoc, packageId: schemaPackage.id };
    this.cache.set(cacheKey, loaded);
    return loaded;
  }

  /** Valida e devolve o resultado, sem lançar em caso de XML inválido. */
  validate(
    xml: string,
    schemaPackage: SchemaPackage = DEFAULT_SCHEMA_PACKAGE,
  ): ValidationResult {
    const { validator } = this.load(schemaPackage);

    let document: XmlDocumentType | undefined;
    try {
      document = XmlDocument.fromString(xml);
    } catch (error) {
      // XML malformado nem chega à validação de schema.
      return {
        valid: false,
        schemaPackageId: schemaPackage.id,
        errors: [translateSchemaError(errorMessage(error))],
      };
    }

    try {
      validator.validate(document);
      return { valid: true, schemaPackageId: schemaPackage.id, errors: [] };
    } catch (error) {
      const errors = errorMessage(error)
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map(translateSchemaError);

      return { valid: false, schemaPackageId: schemaPackage.id, errors };
    } finally {
      document.dispose();
    }
  }

  /** Valida e lança quando inválido — usado no pipeline de emissão. */
  assertValid(xml: string, schemaPackage: SchemaPackage = DEFAULT_SCHEMA_PACKAGE): void {
    const result = this.validate(xml, schemaPackage);
    if (!result.valid) {
      throw new SchemaValidationFailure(result.errors);
    }
  }

  dispose(): void {
    for (const { validator, schemaDoc, packageId } of this.cache.values()) {
      validator.dispose();
      schemaDoc.dispose();
      schemaDirectoriesByPackage.delete(packageId);
    }
    this.cache.clear();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
