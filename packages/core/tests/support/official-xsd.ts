/**
 * Leitura de patterns diretamente dos XSDs oficiais versionados.
 *
 * Os testes de formato não copiam as expressões regulares do leiaute: extraem do
 * arquivo publicado pelo Portal Nacional. Se um pacote de liberação mudar um
 * tipo, o teste falha em vez de continuar verde contra regra revogada.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SCHEMA_DIRECTORY = new URL('../../../../schemas/nfe/PL_010f_v1.04/', import.meta.url);

const SCHEMA_FILES = ['tiposBasico_v4.00.xsd', 'leiauteNFe_v4.00.xsd', 'DFeTiposBasicos_v1.00.xsd'];

export function officialSimpleTypePattern(typeName: string): RegExp {
  for (const fileName of SCHEMA_FILES) {
    const xsd = readFileSync(fileURLToPath(new URL(fileName, SCHEMA_DIRECTORY)), 'utf8');
    const block = new RegExp(
      `<xs:simpleType name="${typeName}">[\\s\\S]*?</xs:simpleType>`,
    ).exec(xsd);
    if (block === null) {
      continue;
    }

    const pattern = /pattern value="([^"]+)"/.exec(block[0]);
    if (pattern?.[1] === undefined) {
      throw new Error(`Tipo ${typeName} encontrado em ${fileName}, mas sem pattern.`);
    }

    // Patterns de XSD são implicitamente ancorados; o grupo preserva alternâncias.
    return new RegExp(`^(?:${pattern[1]})$`);
  }

  throw new Error(`Tipo ${typeName} não encontrado nos XSDs oficiais.`);
}
