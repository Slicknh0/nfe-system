import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { calculateCnpjCheckDigits } from '../src/fiscal/cnpj.js';
import { Environment } from '../src/nfe/document.js';
import {
  InvalidInutilizationRequestError,
  buildUnsignedInutilization,
  inutilizationYear,
  type InutilizationRequest,
} from '../src/nfe/xml/build-inutilization-xml.js';
import { InvalidFiscalTextError } from '../src/nfe/xml/text.js';

/** Pattern do `Id` de `infInut`, lido do leiaute oficial do PL_010d_v1.03. */
function officialInutilizationIdPattern(): RegExp {
  const xsd = readFileSync(
    fileURLToPath(
      new URL('../../../schemas/nfe/PL_010d_v1.03/NFe/leiauteInutNFe_v4.00.xsd', import.meta.url),
    ),
    'utf8',
  );
  const type = /<xs:complexType name="TInutNFe">[\s\S]*?<xs:pattern value="([^"]+)"/.exec(xsd);
  if (type?.[1] === undefined) {
    throw new Error('Pattern do Id de TInutNFe não encontrado no leiaute oficial.');
  }
  return new RegExp(`^(?:${type[1]})$`);
}

const now = new Date('2026-09-12T12:00:00-03:00');

const request = (overrides: Partial<InutilizationRequest> = {}): InutilizationRequest => ({
  environment: Environment.Homologation,
  stateCode: 35,
  year: 2026,
  cnpj: '11222333000181',
  series: 1,
  firstNumber: 5,
  lastNumber: 5,
  justification: 'Numeracao nao utilizada por falha tecnica na transmissao',
  ...overrides,
});

describe('buildUnsignedInutilization', () => {
  it('forma o Id com cUF, ano, CNPJ, modelo, série e faixa, no pattern oficial', () => {
    const { id } = buildUnsignedInutilization(request(), { now });

    expect(id).toBe('ID35261122233300018155001000000005000000005');
    expect(id).toMatch(officialInutilizationIdPattern());
  });

  it('aceita CNPJ alfanumérico no Id', () => {
    const cnpj = `A1B2C3D4E5F6${calculateCnpjCheckDigits('A1B2C3D4E5F6')}`;
    const { id } = buildUnsignedInutilization(request({ cnpj }), { now });
    expect(id).toMatch(officialInutilizationIdPattern());
    expect(id).toContain(cnpj);
  });

  it('monta os campos na ordem do leiaute, sem zeros à esquerda em série e número', () => {
    const { xml, id } = buildUnsignedInutilization(
      request({ series: 12, firstNumber: 40, lastNumber: 42 }),
      { now },
    );
    expect(xml).toContain(
      `<inutNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00"><infInut Id="${id}">` +
        '<tpAmb>2</tpAmb><xServ>INUTILIZAR</xServ><cUF>35</cUF><ano>26</ano>' +
        '<CNPJ>11222333000181</CNPJ><mod>55</mod><serie>12</serie><nNFIni>40</nNFIni>' +
        '<nNFFin>42</nNFFin><xJust>Numeracao nao utilizada por falha tecnica na transmissao</xJust>' +
        '</infInut></inutNFe>',
    );
  });

  it.each([
    ['faixa invertida (I03)', { firstNumber: 9, lastNumber: 8 }],
    ['mais de 10.000 números (I04)', { firstNumber: 1, lastNumber: 10_001 }],
    ['ano anterior a 2006 (I02c)', { year: 2005 }],
    ['ano posterior ao corrente (I02b)', { year: 2027 }],
    ['número zero', { firstNumber: 0 }],
    ['série acima de 999', { series: 1000 }],
    ['justificativa curta', { justification: 'curta demais' }],
    ['justificativa longa', { justification: 'x'.repeat(256) }],
  ])('recusa %s', (_label, overrides) => {
    expect(() => buildUnsignedInutilization(request(overrides), { now })).toThrow(
      InvalidInutilizationRequestError,
    );
  });

  it('aceita exatamente 10.000 números', () => {
    expect(() =>
      buildUnsignedInutilization(request({ firstNumber: 1, lastNumber: 10_000 }), { now }),
    ).not.toThrow();
  });

  it('recusa caractere fora do leiaute na justificativa, apontando o campo', () => {
    expect(() =>
      buildUnsignedInutilization(request({ justification: 'Falha técnica — sem retorno da SEFAZ' }), {
        now,
      }),
    ).toThrow(InvalidFiscalTextError);
  });

  it('recusa CNPJ com dígito verificador inválido', () => {
    expect(() => buildUnsignedInutilization(request({ cnpj: '11222333000180' }), { now })).toThrow();
  });
});

describe('inutilizationYear', () => {
  it('lê o ano da numeração na chave de acesso', () => {
    expect(inutilizationYear('35260911222333000181550010000015231482139670')).toBe(2026);
  });
});
