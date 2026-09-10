import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { NfeSchemaValidator, PL_010F, SchemaValidationFailure } from '../src/index.js';
import { translateSchemaError } from '../src/error-translation.js';

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
const validator = new NfeSchemaValidator(repositoryRoot);

afterAll(() => validator.dispose());

const NFE_NAMESPACE = 'http://www.portalfiscal.inf.br/nfe';

describe('carregamento do pacote oficial', () => {
  it('compila o leiaute resolvendo os xs:include encadeados', () => {
    // Se os includes não resolvessem, qualquer validação lançaria erro de carga.
    const result = validator.validate('<naoNFe/>', PL_010F);
    expect(result.schemaPackageId).toBe('PL_010f_v1.04');
    expect(result.valid).toBe(false);
  });
});

describe('rejeição de documento fora do leiaute', () => {
  it('rejeita Id de infNFe fora do pattern oficial', () => {
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<NFe xmlns="${NFE_NAMESPACE}">` +
      `<infNFe versao="4.00" Id="NFe123"><lixo/></infNFe></NFe>`;

    const result = validator.validate(xml, PL_010F);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('preserva a mensagem técnica original junto da explicação', () => {
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<NFe xmlns="${NFE_NAMESPACE}">` +
      `<infNFe versao="4.00" Id="NFe123"><lixo/></infNFe></NFe>`;

    const [firstError] = validator.validate(xml, PL_010F).errors;
    expect(firstError).toBeDefined();
    expect(firstError?.technicalMessage.length).toBeGreaterThan(0);
    expect(firstError?.explanation.length).toBeGreaterThan(0);
  });

  it('rejeita XML malformado sem derrubar o processo', () => {
    const result = validator.validate('<NFe><infNFe>', PL_010F);
    expect(result.valid).toBe(false);
  });

  it('assertValid lança erro tipado carregando os erros traduzidos', () => {
    expect(() => validator.assertValid('<naoNFe/>', PL_010F)).toThrow(SchemaValidationFailure);

    try {
      validator.assertValid('<naoNFe/>', PL_010F);
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaValidationFailure);
      expect((error as SchemaValidationFailure).errors.length).toBeGreaterThan(0);
    }
  });
});

describe('tradução de erro de schema', () => {
  it('explica violação de pattern em linguagem de negócio', () => {
    const translated = translateSchemaError(
      `Element '{${NFE_NAMESPACE}}infNFe', attribute 'Id': ` +
        `[facet 'pattern'] The value 'NFe123' is not accepted by the pattern '...'`,
    );

    expect(translated.recognized).toBe(true);
    expect(translated.element).toBe('infNFe');
    expect(translated.attribute).toBe('Id');
    expect(translated.explanation).toContain('formato');
    expect(translated.suggestedAction.length).toBeGreaterThan(0);
  });

  it('remove o namespace do nome do elemento na explicação', () => {
    const translated = translateSchemaError(
      `Element '{${NFE_NAMESPACE}}emit': [facet 'maxLength'] value too long`,
    );
    expect(translated.element).toBe('emit');
    expect(translated.explanation).not.toContain('portalfiscal');
  });

  it('admite honestamente quando não reconhece o padrão do erro', () => {
    const translated = translateSchemaError('algo completamente inesperado');
    expect(translated.recognized).toBe(false);
    expect(translated.technicalMessage).toBe('algo completamente inesperado');
    // Não inventa causa fiscal.
    expect(translated.explanation).toContain('ainda não sabe explicar');
  });

  it('explica código fora da lista de valores válidos', () => {
    const translated = translateSchemaError(
      `Element '{${NFE_NAMESPACE}}CSOSN': [facet 'enumeration'] The value '999' is not an element of the set`,
    );
    expect(translated.recognized).toBe(true);
    expect(translated.explanation).toContain('lista');
  });
});
