import { describe, expect, it } from 'vitest';
import { isValidAccessKey, parseAccessKey } from '../src/fiscal/access-key.js';
import { InvalidCnpjError } from '../src/fiscal/cnpj.js';
import {
  EmissionType,
  InvalidNfeDocumentError,
  StateRegistrationIndicator,
} from '../src/nfe/document.js';
import { NFE_NAMESPACE, buildUnsignedNfe } from '../src/nfe/xml/build-nfe-xml.js';
import { XmlValueFormatError } from '../src/nfe/xml/format.js';
import { InvalidFiscalTextError } from '../src/nfe/xml/text.js';
import { d, makeDocument, makeItem } from './fixtures/nfe-document.js';

function segment(xml: string, tag: string): string {
  const start = xml.indexOf(`<${tag}>`);
  const end = xml.indexOf(`</${tag}>`, start);
  return xml.slice(start, end);
}

describe('identificação derivada da chave de acesso', () => {
  it('Id e cDV vêm da mesma chave, e a chave é válida', () => {
    const result = buildUnsignedNfe(makeDocument());

    expect(isValidAccessKey(result.accessKey)).toBe(true);
    expect(result.infNFeId).toBe(`NFe${result.accessKey}`);
    expect(result.xml).toContain(`Id="NFe${result.accessKey}"`);
    expect(result.xml).toContain(`<cDV>${result.accessKey.slice(-1)}</cDV>`);
  });

  it('usa o CNPJ canônico do emitente na chave e no XML', () => {
    const base = makeDocument();
    const result = buildUnsignedNfe({
      ...base,
      issuer: { ...base.issuer, cnpj: '11.222.333/0001-81' },
    });

    expect(parseAccessKey(result.accessKey).cnpj).toBe('11222333000181');
    expect(segment(result.xml, 'emit')).toContain('<CNPJ>11222333000181</CNPJ>');
  });
});

describe('estrutura do documento', () => {
  it('declara namespace e versão do leiaute na raiz', () => {
    const { xml } = buildUnsignedNfe(makeDocument());
    expect(xml.startsWith(
      `<?xml version="1.0" encoding="UTF-8"?><NFe xmlns="${NFE_NAMESPACE}"><infNFe versao="4.00" Id="NFe`,
    )).toBe(true);
  });

  it('monta os grupos de infNFe na ordem do XSD', () => {
    const { xml } = buildUnsignedNfe(
      makeDocument({
        additionalInformation: { complementary: 'Documento emitido por ME ou EPP optante pelo Simples Nacional' },
        technicalResponsible: {
          cnpj: '11222333000181',
          contactName: 'Equipe Fiscal',
          email: 'fiscal@example.com',
          phone: '1133334444',
        },
      }),
    );

    const order = ['<ide>', '<emit>', '<dest>', '<det nItem=', '<total>', '<transp>', '<pag>', '<infAdic>', '<infRespTec>'];
    const positions = order.map((tag) => xml.indexOf(tag));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('numera os itens sequencialmente a partir de 1', () => {
    const { xml } = buildUnsignedNfe(makeDocument({ items: [makeItem(), makeItem(), makeItem()] }));
    const numbers = [...xml.matchAll(/<det nItem="(\d+)">/g)].map((match) => match[1]);
    expect(numbers).toEqual(['1', '2', '3']);
  });

  it('gera XML compacto, sem espaço nem quebra de linha entre tags', () => {
    const { xml } = buildUnsignedNfe(makeDocument());
    expect(xml).not.toMatch(/>\s+</);
    expect(xml).not.toContain('\n');
  });

  it('formata dhEmi com o deslocamento do fuso do emitente', () => {
    const { xml } = buildUnsignedNfe(makeDocument());
    expect(xml).toContain('<dhEmi>2026-09-11T10:15:30-03:00</dhEmi>');
  });

  it('não inclui grupos da reforma tributária para emitente do Simples Nacional', () => {
    const { xml } = buildUnsignedNfe(makeDocument());
    expect(xml).not.toContain('IBSCBS');
    expect(xml).not.toContain('<IS>');
  });
});

describe('itens e totais', () => {
  it('totaliza a partir dos itens e grava vNF coerente', () => {
    const result = buildUnsignedNfe(
      makeDocument({
        items: [
          makeItem({ quantity: d('2'), unitPrice: d('49.90') }),
          makeItem({ quantity: d('1'), unitPrice: d('10.00'), discount: d('0.80') }),
        ],
      }),
    );

    const icmsTot = segment(result.xml, 'ICMSTot');
    expect(icmsTot).toContain('<vProd>109.80</vProd>');
    expect(icmsTot).toContain('<vDesc>0.80</vDesc>');
    expect(icmsTot).toContain('<vNF>109.00</vNF>');
    expect(result.totals.invoice.toFixed(2)).toBe('109.00');
  });

  it('usa SEM GTIN quando o produto não tem código de barras', () => {
    const prod = segment(buildUnsignedNfe(makeDocument()).xml, 'prod');
    expect(prod).toContain('<cEAN>SEM GTIN</cEAN>');
    expect(prod).toContain('<cEANTrib>SEM GTIN</cEANTrib>');
  });

  it('escapa caracteres especiais na descrição', () => {
    const { xml } = buildUnsignedNfe(
      makeDocument({ items: [makeItem({ description: 'Camiseta P&M <edição limitada>' })] }),
    );
    expect(xml).toContain('<xProd>Camiseta P&amp;M &lt;edição limitada&gt;</xProd>');
  });

  it('omite valores opcionais zerados no produto', () => {
    const { xml } = buildUnsignedNfe(makeDocument({ items: [makeItem({ freight: d('0') })] }));
    expect(segment(xml, 'prod')).not.toContain('vFrete');
  });

  it('monta ICMSSN102 e os grupos de PIS e COFINS', () => {
    const imposto = segment(buildUnsignedNfe(makeDocument()).xml, 'imposto');
    expect(imposto).toContain('<ICMS><ICMSSN102><orig>0</orig><CSOSN>102</CSOSN></ICMSSN102></ICMS>');
    expect(imposto).toContain('<PIS><PISOutr><CST>99</CST>');
    expect(imposto).toContain('<COFINS><COFINSOutr><CST>99</CST>');
  });
});

describe('contingência', () => {
  it('SVC-AN com entrada em contingência gera dhCont, xJust e tpEmis 6 na chave', () => {
    const base = makeDocument();
    const result = buildUnsignedNfe({
      ...base,
      identification: {
        ...base.identification,
        emissionType: EmissionType.SvcAn,
        contingency: {
          enteredAt: new Date('2026-09-11T10:00:00-03:00'),
          justification: 'Indisponibilidade da SEFAZ autorizadora de SP',
        },
      },
    });

    expect(result.xml).toContain('<dhCont>2026-09-11T10:00:00-03:00</dhCont>');
    expect(result.xml).toContain('<xJust>Indisponibilidade da SEFAZ autorizadora de SP</xJust>');
    expect(result.accessKey[34]).toBe('6');
  });

  it('recusa emissão em contingência sem justificativa', () => {
    const base = makeDocument();
    expect(() =>
      buildUnsignedNfe({
        ...base,
        identification: { ...base.identification, emissionType: EmissionType.SvcAn },
      }),
    ).toThrow(InvalidNfeDocumentError);
  });

  it('recusa entrada em contingência numa emissão normal', () => {
    const base = makeDocument();
    expect(() =>
      buildUnsignedNfe({
        ...base,
        identification: {
          ...base.identification,
          contingency: { enteredAt: new Date(), justification: 'Justificativa qualquer longa' },
        },
      }),
    ).toThrow(InvalidNfeDocumentError);
  });

  it('recusa tipo de emissão 9, exclusivo de NFC-e', () => {
    const base = makeDocument();
    expect(() =>
      buildUnsignedNfe({
        ...base,
        identification: {
          ...base.identification,
          emissionType: 9 as unknown as typeof EmissionType.Normal,
        },
      }),
    ).toThrow(InvalidNfeDocumentError);
  });
});

describe('recusas na montagem', () => {
  it('CNPJ do emitente com DV errado', () => {
    const base = makeDocument();
    expect(() =>
      buildUnsignedNfe({ ...base, issuer: { ...base.issuer, cnpj: '11222333000182' } }),
    ).toThrow(InvalidCnpjError);
  });

  it('destinatário contribuinte sem inscrição estadual', () => {
    const base = makeDocument();
    expect(() =>
      buildUnsignedNfe({
        ...base,
        recipient: {
          ...base.recipient,
          stateRegistrationIndicator: StateRegistrationIndicator.Contributor,
        },
      }),
    ).toThrow(InvalidNfeDocumentError);
  });

  it('travessão tipográfico na natureza da operação', () => {
    const base = makeDocument();
    expect(() =>
      buildUnsignedNfe({
        ...base,
        identification: { ...base.identification, operationNature: 'Venda — varejo' },
      }),
    ).toThrow(InvalidFiscalTextError);
  });

  it('GTIN com dígito verificador errado', () => {
    expect(() =>
      buildUnsignedNfe(makeDocument({ items: [makeItem({ gtin: '4006381333932' })] })),
    ).toThrow(InvalidFiscalTextError);
  });

  it('quantidade com mais casas do que o leiaute admite', () => {
    expect(() =>
      buildUnsignedNfe(makeDocument({ items: [makeItem({ quantity: d('1.00001') })] })),
    ).toThrow(XmlValueFormatError);
  });

  it('mais de 990 itens', () => {
    const items = Array.from({ length: 991 }, () => makeItem());
    expect(() => buildUnsignedNfe(makeDocument({ items }))).toThrow(InvalidNfeDocumentError);
  });
});
