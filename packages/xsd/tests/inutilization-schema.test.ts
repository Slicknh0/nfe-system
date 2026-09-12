import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { NfeSchemaValidator, PL_010D_INUTILIZATION, PL_010F } from '../src/index.js';

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
const validator = new NfeSchemaValidator(repositoryRoot);

afterAll(() => validator.dispose());

const request = (id: string): string =>
  '<inutNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">' +
  `<infInut Id="${id}"><tpAmb>2</tpAmb><xServ>INUTILIZAR</xServ><cUF>35</cUF><ano>26</ano>` +
  '<CNPJ>11222333000181</CNPJ><mod>55</mod><serie>1</serie><nNFIni>5</nNFIni><nNFFin>5</nNFFin>' +
  '<xJust>Numeracao nao utilizada por falha tecnica</xJust></infInut></inutNFe>';

const messages = (xml: string, pkg = PL_010D_INUTILIZATION): string =>
  validator
    .validate(xml, pkg)
    .errors.map((error) => error.technicalMessage)
    .join('\n');

describe('pedido de inutilização contra o leiaute oficial do PL_010d_v1.03', () => {
  it('compila a raiz sobre o leiaute oficial e aponta só a assinatura ausente', () => {
    const result = validator.validate(
      request('ID35261122233300018155001000000005000000005'),
      PL_010D_INUTILIZATION,
    );

    expect(result.schemaPackageId).toBe('PL_010d_v1.03');
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.technicalMessage).toContain('Signature');
  });

  it('recusa Id fora do pattern oficial', () => {
    expect(messages(request('ID35'))).toContain('Id');
  });

  it('recusa xServ diferente do literal INUTILIZAR', () => {
    const xml = request('ID35261122233300018155001000000005000000005').replace(
      '<xServ>INUTILIZAR</xServ>',
      '<xServ>CONSULTAR</xServ>',
    );
    expect(messages(xml)).toContain('xServ');
  });

  it('o pacote de NF-e não aceita o pedido de inutilização, e os dois convivem no mesmo validador', () => {
    expect(validator.validate(request('ID35261122233300018155001000000005000000005'), PL_010F).valid).toBe(
      false,
    );
    expect(messages(request('ID35261122233300018155001000000005000000005'))).toContain('Signature');
  });
});
