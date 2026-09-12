import { Environment, buildUnsignedNfe, requiresReconciliation } from '@nfe/core';
import { describe, expect, it } from 'vitest';
import { makeDocument } from '../../core/tests/fixtures/nfe-document.js';
import { officialSimpleTypePattern } from '../../core/tests/support/official-xsd.js';
import {
  MockSefazProvider,
  ProviderConfigurationError,
  SefazCommunicationError,
  createSefazProvider,
  type AuthorizationRequest,
  type ProtocolQueryRequest,
} from '../src/index.js';

const unsigned = buildUnsignedNfe(makeDocument());

const request: AuthorizationRequest = {
  environment: Environment.Homologation,
  accessKey: unsigned.accessKey,
  // O mock só lê o Id e o DigestValue; a assinatura real é testada em @nfe/signer.
  signedXml: unsigned.xml.replace(
    '</NFe>',
    '<Signature><SignedInfo><Reference><DigestValue>ZGlnZXN0</DigestValue></Reference></SignedInfo></Signature></NFe>',
  ),
};

const query: ProtocolQueryRequest = {
  environment: Environment.Homologation,
  accessKey: unsigned.accessKey,
};

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('A operação deveria ter falhado.');
}

describe('envio', () => {
  it('autoriza por padrão, com protocolo no formato TProt e digVal do XML', async () => {
    const result = await new MockSefazProvider().authorize(request);

    expect(result.kind).toBe('AUTHORIZED');
    if (result.kind === 'AUTHORIZED') {
      expect(result.protocol.protocolNumber).toMatch(officialSimpleTypePattern('TProt'));
      expect(result.protocol.digestValue).toBe('ZGlnZXN0');
      expect(result.protocol.statusCode).toBe(100);
      expect(result.protocol.statusReason).toBe('Autorizado o uso da NF-e');
    }
  });

  it('segundo envio da mesma chave é duplicidade (204)', async () => {
    const sefaz = new MockSefazProvider();
    await sefaz.authorize(request);

    expect(await sefaz.authorize(request)).toEqual({
      kind: 'DUPLICATE',
      statusCode: 204,
      statusReason: 'Rejeição: Duplicidade de NF-e',
    });
  });

  it('denegação fica registrada e é devolvida na consulta', async () => {
    const sefaz = new MockSefazProvider().scriptAuthorizations({ type: 'deny', statusCode: 302 });

    expect((await sefaz.authorize(request)).kind).toBe('DENIED');
    expect(await sefaz.queryProtocol(query)).toMatchObject({
      kind: 'DENIED',
      protocol: { statusCode: 302, statusReason: 'Uso Denegado: Irregularidade fiscal do destinatário' },
    });
  });

  it('rejeição não registra nada na SEFAZ', async () => {
    const sefaz = new MockSefazProvider().scriptAuthorizations({
      type: 'reject',
      statusCode: 999,
      statusReason: 'Rejeição de teste',
    });

    expect((await sefaz.authorize(request)).kind).toBe('REJECTED');
    expect((await sefaz.queryProtocol(query)).kind).toBe('NOT_FOUND');
  });

  it('serviço paralisado responde 108 sem processar', async () => {
    const sefaz = new MockSefazProvider().scriptAuthorizations({ type: 'service-unavailable' });

    expect(await sefaz.authorize(request)).toMatchObject({ kind: 'SERVICE_UNAVAILABLE', statusCode: 108 });
    expect((await sefaz.queryProtocol(query)).kind).toBe('NOT_FOUND');
  });

  it('lote recebido para processamento é encontrado depois pela consulta', async () => {
    const sefaz = new MockSefazProvider().scriptAuthorizations({ type: 'accept-for-processing' });

    expect(await sefaz.authorize(request)).toMatchObject({ kind: 'IN_PROCESSING', statusCode: 103 });
    expect((await sefaz.queryProtocol(query)).kind).toBe('AUTHORIZED');
  });
});

describe('falhas técnicas distinguem desfecho conhecido de desconhecido', () => {
  it('falha antes do envio: nada processado, não exige reconciliação', async () => {
    const sefaz = new MockSefazProvider().scriptAuthorizations({ type: 'fail-before-sending' });

    const error = await failure(sefaz.authorize(request));
    expect(error).toBeInstanceOf(SefazCommunicationError);
    expect((error as SefazCommunicationError).phase).toBe('NOT_SENT');
    expect(requiresReconciliation(error)).toBe(false);
    expect((await sefaz.queryProtocol(query)).kind).toBe('NOT_FOUND');
  });

  it('resposta perdida depois de autorizar: exige reconciliação, e a consulta acha a autorização', async () => {
    const sefaz = new MockSefazProvider().scriptAuthorizations({
      type: 'lose-response-after-processing',
    });

    const error = await failure(sefaz.authorize(request));
    expect(requiresReconciliation(error)).toBe(true);
    expect((await sefaz.queryProtocol(query)).kind).toBe('AUTHORIZED');
  });

  it('requisição perdida: o emissor vê o mesmo timeout, mas a SEFAZ não tem a nota', async () => {
    const sefaz = new MockSefazProvider().scriptAuthorizations({ type: 'lose-request' });

    const error = await failure(sefaz.authorize(request));
    expect(requiresReconciliation(error)).toBe(true);
    expect(await sefaz.queryProtocol(query)).toEqual({
      kind: 'NOT_FOUND',
      statusCode: 217,
      statusReason: 'Rejeição: NF-e não consta na base de dados da SEFAZ',
    });
  });

  it('consulta com resposta perdida pode ser repetida', async () => {
    const sefaz = new MockSefazProvider().scriptQueries({ type: 'lose-response' });
    await sefaz.authorize(request);

    expect(requiresReconciliation(await failure(sefaz.queryProtocol(query)))).toBe(true);
    expect((await sefaz.queryProtocol(query)).kind).toBe('AUTHORIZED');
    expect(sefaz.countCalls('PROTOCOL_QUERY', query.accessKey)).toBe(2);
    expect(sefaz.countCalls('AUTHORIZATION')).toBe(1);
  });
});

describe('proteções do mock', () => {
  it('recusa produção no envio e na consulta, sem registrar chamada', async () => {
    const sefaz = new MockSefazProvider();
    const production = { environment: Environment.Production } as const;

    expect(await failure(sefaz.authorize({ ...request, ...production }))).toBeInstanceOf(
      ProviderConfigurationError,
    );
    expect(await failure(sefaz.queryProtocol({ ...query, ...production }))).toBeInstanceOf(
      ProviderConfigurationError,
    );
    expect(sefaz.calls).toHaveLength(0);
  });

  it('recusa XML que não corresponde à chave informada', async () => {
    const other = { ...request, accessKey: request.accessKey.replace(/.$/, '0') };
    expect(await failure(new MockSefazProvider().authorize(other))).toBeInstanceOf(
      ProviderConfigurationError,
    );
  });
});

describe('createSefazProvider', () => {
  it('entrega o mock em homologação', () => {
    expect(createSefazProvider({ kind: 'mock', environment: Environment.Homologation }).name).toBe('mock');
  });

  it('recusa o mock em produção', () => {
    expect(() => createSefazProvider({ kind: 'mock', environment: Environment.Production })).toThrow(
      ProviderConfigurationError,
    );
  });

  it('provider SOAP exige transporte com o certificado de transmissão', () => {
    expect(() => createSefazProvider({ kind: 'soap', environment: Environment.Homologation })).toThrow(
      /exige transporte/,
    );
  });
});
