/**
 * Árvore XML mínima e serializador determinístico.
 *
 * Decisão arquitetural: o documento fiscal é montado como árvore tipada e
 * serializado por um único ponto que escapa texto e atributos. Não há
 * concatenação de fragmentos XML espalhada pelo código.
 *
 * Uma biblioteca de construção de XML genérica não foi adotada porque o domínio
 * exige três garantias que precisam ser verificáveis por teste, e que ficam mais
 * visíveis num serializador pequeno do que dentro de uma dependência:
 *
 * - saída compacta, sem espaço ou quebra de linha entre tags;
 * - ordem de filhos e atributos exatamente a de construção — a ordem do XSD é
 *   obrigatória e o builder é quem a garante;
 * - recusa de caractere proibido pelo XML 1.0 no momento da montagem, e não na
 *   SEFAZ.
 *
 * A assinatura digital é calculada sobre a forma canônica (C14N), então a
 * representação textual daqui não precisa coincidir byte a byte com a de outra
 * ferramenta — só precisa ser XML bem formado e fiel à árvore.
 */

import { FiscalError } from '../errors.js';

export class XmlStructureError extends FiscalError {}

export interface XmlText {
  readonly kind: 'text';
  readonly value: string;
}

export interface XmlAttribute {
  readonly name: string;
  readonly value: string;
}

export interface XmlElement {
  readonly kind: 'element';
  readonly name: string;
  readonly attributes: readonly XmlAttribute[];
  readonly children: readonly XmlNode[];
}

export type XmlNode = XmlElement | XmlText;

/** Filho aceito na montagem: grupo opcional ausente chega como `undefined`. */
export type XmlChild = XmlNode | undefined;

const XML_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?$/;

function formatCodeUnit(code: number): string {
  return `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
}

/**
 * Verifica o conjunto de caracteres do XML 1.0.
 *
 * Feito por inspeção de código de caractere, e não por expressão regular, para
 * tratar corretamente pares substitutos: um emoji é XML válido, um substituto
 * isolado não é.
 */
function assertXmlCharacters(value: string, context: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    const isHighSurrogate = code >= 0xd800 && code <= 0xdbff;
    if (isHighSurrogate) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
    }

    const isForbiddenControl = code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d;
    const isLowSurrogate = code >= 0xdc00 && code <= 0xdfff;
    const isNonCharacter = code === 0xfffe || code === 0xffff;

    if (isForbiddenControl || isHighSurrogate || isLowSurrogate || isNonCharacter) {
      throw new XmlStructureError(
        `${context} contém caractere inválido em XML 1.0 (${formatCodeUnit(code)}) na posição ${index}.`,
      );
    }
  }
}

function assertName(name: string): void {
  if (!XML_NAME.test(name)) {
    throw new XmlStructureError(`Nome XML inválido: ${JSON.stringify(name)}.`);
  }
}

export function text(value: string): XmlText {
  assertXmlCharacters(value, 'Texto');
  return { kind: 'text', value };
}

/**
 * Monta um elemento.
 *
 * Atributos com valor `undefined` e filhos `undefined` são omitidos, o que
 * permite declarar grupos opcionais na posição exigida pelo XSD sem `if`
 * espalhado.
 */
export function element(
  name: string,
  children: readonly XmlChild[] = [],
  attributes: Readonly<Record<string, string | undefined>> = {},
): XmlElement {
  assertName(name);

  const attributeList: XmlAttribute[] = [];
  for (const [attributeName, attributeValue] of Object.entries(attributes)) {
    if (attributeValue === undefined) {
      continue;
    }
    assertName(attributeName);
    assertXmlCharacters(attributeValue, `Atributo ${attributeName} de <${name}>`);
    attributeList.push({ name: attributeName, value: attributeValue });
  }

  const childList = children.filter((child): child is XmlNode => child !== undefined);

  return { kind: 'element', name, attributes: attributeList, children: childList };
}

/** Elemento com conteúdo textual. */
export function leaf(name: string, value: string): XmlElement {
  return element(name, [text(value)]);
}

/** Elemento textual omitido quando o valor não existe. */
export function optionalLeaf(name: string, value: string | undefined): XmlElement | undefined {
  return value === undefined ? undefined : leaf(name, value);
}

function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r/g, '&#13;');
}

function escapeAttribute(value: string): string {
  return escapeText(value)
    .replace(/"/g, '&quot;')
    .replace(/\t/g, '&#9;')
    .replace(/\n/g, '&#10;');
}

function writeElement(node: XmlElement, parts: string[]): void {
  parts.push('<', node.name);
  for (const attribute of node.attributes) {
    parts.push(' ', attribute.name, '="', escapeAttribute(attribute.value), '"');
  }

  if (node.children.length === 0) {
    parts.push('/>');
    return;
  }

  parts.push('>');
  for (const child of node.children) {
    if (child.kind === 'text') {
      parts.push(escapeText(child.value));
    } else {
      writeElement(child, parts);
    }
  }
  parts.push('</', node.name, '>');
}

export interface SerializeOptions {
  /** Emite `<?xml version="1.0" encoding="UTF-8"?>`. Padrão: `true`. */
  readonly declaration?: boolean;
}

/** Serializa em forma compacta, sem qualquer espaço entre tags. */
export function serializeXml(root: XmlElement, options: SerializeOptions = {}): string {
  const parts: string[] = [];
  if (options.declaration ?? true) {
    parts.push('<?xml version="1.0" encoding="UTF-8"?>');
  }
  writeElement(root, parts);
  return parts.join('');
}
