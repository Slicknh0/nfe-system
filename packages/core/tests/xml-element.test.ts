import { describe, expect, it } from 'vitest';
import {
  XmlStructureError,
  element,
  leaf,
  serializeXml,
  text,
} from '../src/xml/element.js';

const bare = { declaration: false } as const;

describe('serializeXml', () => {
  it('serializa de forma compacta, sem espaço entre tags', () => {
    const xml = serializeXml(element('a', [leaf('b', '1'), leaf('c', '2')]), bare);
    expect(xml).toBe('<a><b>1</b><c>2</c></a>');
  });

  it('emite a declaração XML por padrão', () => {
    expect(serializeXml(element('a'))).toBe('<?xml version="1.0" encoding="UTF-8"?><a/>');
  });

  it('escapa conteúdo textual', () => {
    expect(serializeXml(leaf('x', 'A & B <C> "D"'), bare)).toBe(
      '<x>A &amp; B &lt;C&gt; "D"</x>',
    );
  });

  it('escapa valores de atributo, incluindo aspas', () => {
    expect(serializeXml(element('x', [], { a: 'diz "oi" & <vai>' }), bare)).toBe(
      '<x a="diz &quot;oi&quot; &amp; &lt;vai&gt;"/>',
    );
  });

  it('preserva a ordem de construção de filhos e atributos', () => {
    const xml = serializeXml(
      element('x', [leaf('z', '1'), leaf('a', '2')], { versao: '4.00', Id: 'NFe1' }),
      bare,
    );
    expect(xml).toBe('<x versao="4.00" Id="NFe1"><z>1</z><a>2</a></x>');
  });

  it('omite filhos e atributos ausentes', () => {
    const xml = serializeXml(element('x', [undefined, leaf('y', '1')], { a: undefined, b: '2' }), bare);
    expect(xml).toBe('<x b="2"><y>1</y></x>');
  });
});

describe('validação estrutural', () => {
  it('recusa nome de elemento inválido', () => {
    expect(() => element('1abc')).toThrow(XmlStructureError);
  });

  it('recusa caractere de controle proibido pelo XML 1.0', () => {
    expect(() => text('ab')).toThrow(XmlStructureError);
  });

  it('aceita par substituto completo', () => {
    // Emoji é XML válido; recusá-lo é papel da camada fiscal, não do XML.
    expect(() => text('ok 😀')).not.toThrow();
  });

  it('recusa substituto isolado', () => {
    expect(() => text('\uD800x')).toThrow(XmlStructureError);
  });
});
