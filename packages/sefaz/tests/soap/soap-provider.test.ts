/**
 * Provider SOAP contra uma SEFAZ local com autenticação mútua real.
 *
 * Mensagens enviadas e respostas roteirizadas são validadas contra o XSD
 * oficial. O que não pode ser verificado sem certificado A1 e credenciamento —
 * a SEFAZ-SP real — está fora destes testes e registrado no README.
 */

import { X509Certificate } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  Environment,
  buildUnsignedInutilization,
  buildUnsignedNfe,
  requiresReconciliation,
} from '@nfe/core';
import { signInutilizationXml, signNfeXml } from '@nfe/signer';
import { NfeSchemaValidator, PL_010D_INUTILIZATION } from '@nfe/xsd';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestPki, type IssuedCertificate } from '../../../certificates/tests/support/test-pki.js';
import { makeDocument } from '../../../core/tests/fixtures/nfe-document.js';
import { createTestCredentials } from '../../../signer/tests/support/credentials.js';
import {
  HttpsSoapTransport,
  ICP_BRASIL_ROOT_V10,
  ProviderConfigurationError,
  SEFAZ_SP_ENDPOINTS,
  SefazCommunicationError,
  SoapSefazProvider,
  buildSoapRequest,
  soapAction,
  soapNamespace,
  type SoapSefazProviderOptions,
} from '../../src/index.js';
import {
  FakeSefaz,
  dropConnection,
  httpStatus,
  neverRespond,
  payloadOf,
  soapFault,
  soapResult,
} from './support/fake-sefaz.js';
import { SCHEMAS, retConsSitNFe, retEnviNFe, retInutNFe } from './support/sefaz-responses.js';

const repositoryRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const validator = new NfeSchemaValidator(repositoryRoot);
const CNPJ = '11222333000181';
const PROTOCOL_NUMBER = '135260000000123';

let pki: TestPki;
let clientCertificate: IssuedCertificate;
let sefaz: FakeSefaz;
let signedNfe: string;
let accessKey: string;
let signedInutilization: string;

function transport(overrides: Partial<ConstructorParameters<typeof HttpsSoapTransport>[0]> = {}) {
  return new HttpsSoapTransport({
    credentials: { privateKeyPem: clientCertificate.privateKeyPem, certificatePem: clientCertificate.certificatePem },
    trustedCertificatesPem: [pki.root.certificatePem],
    connectTimeoutMs: 3000,
    responseTimeoutMs: 1500,
    ...overrides,
  });
}

function provider(overrides: Partial<SoapSefazProviderOptions> = {}) {
  return new SoapSefazProvider({
    environment: Environment.Homologation,
    transport: transport(),
    endpoints: sefaz.endpoints(),
    batchId: () => '202609121500001',
    ...overrides,
  });
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('A operação deveria ter falhado.');
}

function schemaErrors(xml: string, schema: (typeof SCHEMAS)[keyof typeof SCHEMAS]): string[] {
  return validator.validate(xml, schema).errors.map((error) => error.technicalMessage);
}

beforeAll(async () => {
  pki = new TestPki('AC Raiz SEFAZ de teste');
  const serverCertificate = pki.issue({
    commonName: 'localhost',
    dnsNames: ['localhost'],
    ipAddresses: ['127.0.0.1'],
    serverAuth: true,
  });
  clientCertificate = pki.issue({ commonName: 'TRANSMISSOR DE TESTE', cnpj: CNPJ, clientAuth: true });
  sefaz = await FakeSefaz.start({ serverCertificate, trustedClientRootsPem: [pki.root.certificatePem] });

  const signingCredentials = createTestCredentials();
  const unsigned = buildUnsignedNfe(makeDocument());
  accessKey = unsigned.accessKey;
  signedNfe = signNfeXml(unsigned.xml, signingCredentials);
  signedInutilization = signInutilizationXml(
    buildUnsignedInutilization({
      environment: Environment.Homologation,
      stateCode: 35,
      year: 2026,
      cnpj: CNPJ,
      series: 1,
      firstNumber: 1523,
      lastNumber: 1523,
      justification: 'Numeracao nao utilizada por falha tecnica',
    }).xml,
    signingCredentials,
  );
}, 60_000);

afterAll(async () => {
  validator.dispose();
  await sefaz.close();
});

describe('catálogo oficial e envelope', () => {
  it('usa as URLs publicadas pela SEFAZ-SP', () => {
    expect(SEFAZ_SP_ENDPOINTS[Environment.Homologation].AUTHORIZATION.url).toBe(
      'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfeautorizacao4.asmx',
    );
    expect(SEFAZ_SP_ENDPOINTS[Environment.Homologation].PROTOCOL_QUERY.url).toBe(
      'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfeconsultaprotocolo4.asmx',
    );
    expect(SEFAZ_SP_ENDPOINTS[Environment.Homologation].NUMBER_VOID.url).toBe(
      'https://homologacao.nfe.fazenda.sp.gov.br/ws/nfeinutilizacao4.asmx',
    );
    expect(SEFAZ_SP_ENDPOINTS[Environment.Production].AUTHORIZATION.url).toBe(
      'https://nfe.fazenda.sp.gov.br/ws/nfeautorizacao4.asmx',
    );
    expect(SEFAZ_SP_ENDPOINTS[Environment.Production].PROTOCOL_QUERY.url).toBe(
      'https://nfe.fazenda.sp.gov.br/ws/nfeconsultaprotocolo4.asmx',
    );
    expect(SEFAZ_SP_ENDPOINTS[Environment.Production].NUMBER_VOID.url).toBe(
      'https://nfe.fazenda.sp.gov.br/ws/nfeinutilizacao4.asmx',
    );
  });

  it('monta namespace, ação e envelope SOAP 1.2 sem declaração XML interna', () => {
    const endpoint = SEFAZ_SP_ENDPOINTS[Environment.Homologation].AUTHORIZATION;
    const request = buildSoapRequest(endpoint, '<?xml version="1.0" encoding="UTF-8"?><enviNFe/>');

    expect(soapNamespace(endpoint)).toBe('http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4');
    expect(soapAction(endpoint)).toBe('http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4/nfeAutorizacaoLote');
    expect(request.contentType).toBe(
      'application/soap+xml; charset=utf-8; action="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4/nfeAutorizacaoLote"',
    );
    expect(request.body.match(/<\?xml/g)).toHaveLength(1);
    expect(request.body).toContain(
      '<soap12:Body><nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4"><enviNFe/></nfeDadosMsg>',
    );
  });

  it('a raiz ICP-Brasil v10 embutida confere com o fingerprint fixado', () => {
    const root = new X509Certificate(ICP_BRASIL_ROOT_V10.pem);
    expect(root.fingerprint256).toBe(ICP_BRASIL_ROOT_V10.sha256);
    expect(root.subject).toContain('CN=Autoridade Certificadora Raiz Brasileira v10');
    expect(root.verify(root.publicKey)).toBe(true);
    expect(new Date(root.validTo).getTime()).toBeGreaterThan(Date.now());
  });
});

describe('autorização', () => {
  it('envia enviNFe válido no XSD, com autenticação mútua, e lê a autorização', async () => {
    const response = retEnviNFe({
      statusCode: 104,
      statusReason: 'Lote processado',
      protocol: { accessKey, statusCode: 100, statusReason: 'Autorizado o uso da NF-e', protocolNumber: PROTOCOL_NUMBER },
    });
    expect(schemaErrors(response, SCHEMAS.retEnviNFe)).toEqual([]);
    sefaz.respondWith(soapResult(response));

    const result = await provider().authorize({ environment: Environment.Homologation, accessKey, signedXml: signedNfe });

    const request = sefaz.requests.at(-1)!;
    expect(request.path).toBe('/ws/nfeautorizacao4.asmx');
    expect(request.contentType).toContain('action="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4/nfeAutorizacaoLote"');
    expect(request.clientCommonName).toBe('TRANSMISSOR DE TESTE');
    const payload = payloadOf(request);
    expect(payload).toContain('<idLote>202609121500001</idLote><indSinc>1</indSinc><NFe');
    expect(schemaErrors(payload, SCHEMAS.enviNFe)).toEqual([]);

    expect(result.kind).toBe('AUTHORIZED');
    if (result.kind === 'AUTHORIZED') {
      expect(result.protocol).toMatchObject({ accessKey, statusCode: 100, protocolNumber: PROTOCOL_NUMBER });
      expect(result.protocol.receivedAt.toISOString()).toBe('2026-09-12T18:00:00.000Z');
      expect(result.protocol.xml).toContain('<protNFe');
      expect(result.protocol.xml).not.toContain('soap');
    }
  });

  it('lote rejeitado sem protocolo é rejeição', async () => {
    const response = retEnviNFe({ statusCode: 225, statusReason: 'Rejeição de teste no lote' });
    expect(schemaErrors(response, SCHEMAS.retEnviNFe)).toEqual([]);
    sefaz.respondWith(soapResult(response));

    expect(await provider().authorize({ environment: 2, accessKey, signedXml: signedNfe })).toEqual({
      kind: 'REJECTED',
      statusCode: 225,
      statusReason: 'Rejeição de teste no lote',
    });
  });

  it('protocolo sem número: rejeição ou duplicidade conforme o cStat da NF-e', async () => {
    const rejected = retEnviNFe({
      statusCode: 104,
      statusReason: 'Lote processado',
      protocol: { accessKey, statusCode: 999, statusReason: 'Rejeição de teste na nota' },
    });
    const duplicate = retEnviNFe({
      statusCode: 104,
      statusReason: 'Lote processado',
      protocol: { accessKey, statusCode: 204, statusReason: 'Rejeição: Duplicidade de NF-e' },
    });
    expect(schemaErrors(rejected, SCHEMAS.retEnviNFe)).toEqual([]);
    sefaz.respondWith(soapResult(rejected), soapResult(duplicate));

    expect((await provider().authorize({ environment: 2, accessKey, signedXml: signedNfe })).kind).toBe('REJECTED');
    expect((await provider().authorize({ environment: 2, accessKey, signedXml: signedNfe })).kind).toBe('DUPLICATE');
  });

  it('resposta de outro ambiente não é aceita e fica como desfecho desconhecido', async () => {
    sefaz.respondWith(
      soapResult(
        retEnviNFe({
          environment: 1,
          statusCode: 104,
          statusReason: 'Lote processado',
          protocol: { accessKey, environment: 1, statusCode: 100, statusReason: 'Autorizado', protocolNumber: PROTOCOL_NUMBER },
        }),
      ),
    );

    const error = await failure(provider().authorize({ environment: 2, accessKey, signedXml: signedNfe }));
    expect(error).toBeInstanceOf(SefazCommunicationError);
    expect(requiresReconciliation(error)).toBe(true);
  });
});

describe('falhas de transporte', () => {
  it('SOAP Fault é desfecho desconhecido e preserva o motivo', async () => {
    sefaz.respondWith(soapFault('Servidor indisponível para processar a mensagem'));
    const error = await failure(provider().authorize({ environment: 2, accessKey, signedXml: signedNfe }));

    expect(requiresReconciliation(error)).toBe(true);
    expect((error as Error).message).toContain('Servidor indisponível para processar a mensagem');
  });

  it('HTTP 4xx é recusa antes do processamento: configuração, não reenvio às cegas', async () => {
    sefaz.respondWith(httpStatus(403));
    const error = await failure(provider().authorize({ environment: 2, accessKey, signedXml: signedNfe }));
    expect(error).toBeInstanceOf(ProviderConfigurationError);
  });

  it('conexão derrubada depois do envio exige reconciliação', async () => {
    sefaz.respondWith(dropConnection());
    const error = await failure(provider().authorize({ environment: 2, accessKey, signedXml: signedNfe }));

    expect(error).toBeInstanceOf(SefazCommunicationError);
    expect((error as SefazCommunicationError).phase).toBe('SENT_WITHOUT_RESPONSE');
  });

  it('tempo de resposta esgotado exige reconciliação', async () => {
    sefaz.respondWith(neverRespond());
    const error = await failure(provider().authorize({ environment: 2, accessKey, signedXml: signedNfe }));

    expect((error as SefazCommunicationError).phase).toBe('SENT_WITHOUT_RESPONSE');
  });

  it('servidor com certificado fora das raízes confiáveis: nada é enviado', async () => {
    const before = sefaz.requests.length;
    const stranger = new TestPki('AC estranha');
    const untrusting = provider({ transport: transport({ trustedCertificatesPem: [stranger.root.certificatePem] }) });

    const error = await failure(untrusting.authorize({ environment: 2, accessKey, signedXml: signedNfe }));
    expect((error as SefazCommunicationError).phase).toBe('NOT_SENT');
    expect(sefaz.requests.length).toBe(before);
  });

  it('certificado de cliente recusado no TLS: a aplicação do servidor não recebe nada, e o cliente é conservador', async () => {
    const before = sefaz.requests.length;
    const outsider = new TestPki('AC de outro emissor').issue({ cnpj: CNPJ, clientAuth: true });
    const rejected = provider({
      transport: transport({ credentials: { privateKeyPem: outsider.privateKeyPem, certificatePem: outsider.certificatePem } }),
    });

    const error = await failure(rejected.authorize({ environment: 2, accessKey, signedXml: signedNfe }));

    // No TLS 1.3 o servidor recusa o certificado depois que o cliente já enviou
    // o corpo, e o Node entrega só ECONNRESET, sem o alerta. Do lado do cliente
    // isso é indistinguível de "recebeu e derrubou": desfecho desconhecido.
    expect(error).toBeInstanceOf(SefazCommunicationError);
    expect(requiresReconciliation(error)).toBe(true);
    expect(sefaz.requests.length).toBe(before);
  });

  it('porta sem servidor: nada é enviado', async () => {
    const port = await new Promise<number>((resolve) => {
      const probe = createServer();
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address();
        const free = typeof address === 'object' && address !== null ? address.port : 0;
        probe.close(() => resolve(free));
      });
    });
    const endpoints = sefaz.endpoints();
    const offline = provider({
      endpoints: { ...endpoints, AUTHORIZATION: { ...endpoints.AUTHORIZATION, url: `https://localhost:${port}/ws/x.asmx` } },
    });

    const error = await failure(offline.authorize({ environment: 2, accessKey, signedXml: signedNfe }));
    expect((error as SefazCommunicationError).phase).toBe('NOT_SENT');
  });

  it('produção exige liberação explícita, e o ambiente do documento precisa bater', async () => {
    expect(() => provider({ environment: Environment.Production })).toThrow(ProviderConfigurationError);
    expect(
      await failure(provider().authorize({ environment: Environment.Production, accessKey, signedXml: signedNfe })),
    ).toBeInstanceOf(ProviderConfigurationError);
  });
});

describe('consulta de protocolo', () => {
  it('envia consSitNFe válido no XSD oficial e lê autorização encontrada', async () => {
    const response = retConsSitNFe({
      statusCode: 100,
      statusReason: 'Autorizado o uso da NF-e',
      accessKey,
      protocol: { accessKey, statusCode: 100, statusReason: 'Autorizado o uso da NF-e', protocolNumber: PROTOCOL_NUMBER },
    });
    expect(schemaErrors(response, SCHEMAS.retConsSitNFe)).toEqual([]);
    sefaz.respondWith(soapResult(response, 'NFeConsultaProtocolo4'));

    const result = await provider().queryProtocol({ environment: 2, accessKey });

    const request = sefaz.requests.at(-1)!;
    expect(request.path).toBe('/ws/nfeconsultaprotocolo4.asmx');
    expect(schemaErrors(payloadOf(request), SCHEMAS.consSitNFe)).toEqual([]);
    expect(result).toMatchObject({ kind: 'AUTHORIZED', protocol: { protocolNumber: PROTOCOL_NUMBER } });
  });

  it('217 é NF-e não encontrada', async () => {
    const response = retConsSitNFe({
      statusCode: 217,
      statusReason: 'Rejeição: NF-e não consta na base de dados da SEFAZ',
      accessKey,
    });
    expect(schemaErrors(response, SCHEMAS.retConsSitNFe)).toEqual([]);
    sefaz.respondWith(soapResult(response, 'NFeConsultaProtocolo4'));

    expect((await provider().queryProtocol({ environment: 2, accessKey })).kind).toBe('NOT_FOUND');
  });
});

describe('inutilização', () => {
  it('envia o inutNFe assinado válido no XSD e lê a homologação com o XML de retorno', async () => {
    const response = retInutNFe({
      statusCode: 102,
      statusReason: 'Inutilização de número homologado',
      cnpj: CNPJ,
      series: 1,
      number: 1523,
      protocolNumber: PROTOCOL_NUMBER,
    });
    expect(schemaErrors(response, SCHEMAS.retInutNFe)).toEqual([]);
    sefaz.respondWith(soapResult(response, 'NFeInutilizacao4'));

    const result = await provider().voidNumbers({
      environment: 2,
      cnpj: CNPJ,
      series: 1,
      firstNumber: 1523,
      lastNumber: 1523,
      signedXml: signedInutilization,
    });

    const request = sefaz.requests.at(-1)!;
    expect(request.path).toBe('/ws/nfeinutilizacao4.asmx');
    expect(validator.validate(payloadOf(request), PL_010D_INUTILIZATION).errors).toEqual([]);
    expect(result).toMatchObject({ kind: 'VOIDED', protocol: { statusCode: 102, protocolNumber: PROTOCOL_NUMBER } });
    if (result.kind === 'VOIDED') {
      expect(result.protocol.xml).toContain('<retInutNFe');
    }
  });

  it('241 é número já utilizado', async () => {
    const response = retInutNFe({
      statusCode: 241,
      statusReason: 'Rejeição: Um número da faixa já foi utilizado',
      cnpj: CNPJ,
      series: 1,
      number: 1523,
    });
    expect(schemaErrors(response, SCHEMAS.retInutNFe)).toEqual([]);
    sefaz.respondWith(soapResult(response, 'NFeInutilizacao4'));

    const result = await provider().voidNumbers({
      environment: 2,
      cnpj: CNPJ,
      series: 1,
      firstNumber: 1523,
      lastNumber: 1523,
      signedXml: signedInutilization,
    });
    expect(result.kind).toBe('NUMBER_ALREADY_USED');
  });
});
