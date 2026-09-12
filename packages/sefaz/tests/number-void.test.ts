import {
  Environment,
  buildUnsignedInutilization,
  buildUnsignedNfe,
  requiresReconciliation,
} from '@nfe/core';
import { describe, expect, it } from 'vitest';
import { makeDocument } from '../../core/tests/fixtures/nfe-document.js';
import { officialSimpleTypePattern } from '../../core/tests/support/official-xsd.js';
import {
  MockSefazProvider,
  ProviderConfigurationError,
  interpretNumberVoidResponse,
  type AuthorizationRequest,
  type NumberVoidRequest,
} from '../src/index.js';

const CNPJ = '11222333000181';
const invoice = buildUnsignedNfe(makeDocument());
const INVOICE_NUMBER = 1523;

const authorization: AuthorizationRequest = {
  environment: Environment.Homologation,
  accessKey: invoice.accessKey,
  signedXml: invoice.xml,
};

function voidRequest(firstNumber: number, lastNumber = firstNumber): NumberVoidRequest {
  return {
    environment: Environment.Homologation,
    cnpj: CNPJ,
    series: 1,
    firstNumber,
    lastNumber,
    signedXml: buildUnsignedInutilization({
      environment: Environment.Homologation,
      stateCode: 35,
      year: 2026,
      cnpj: CNPJ,
      series: 1,
      firstNumber,
      lastNumber,
      justification: 'Numeracao nao utilizada por falha tecnica',
    }).xml,
  };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('A operação deveria ter falhado.');
}

describe('inutilização na SEFAZ simulada', () => {
  it('homologa número livre (102) com protocolo no formato TProt', async () => {
    const result = await new MockSefazProvider().voidNumbers(voidRequest(INVOICE_NUMBER));

    expect(result.kind).toBe('VOIDED');
    if (result.kind === 'VOIDED') {
      expect(result.protocol.statusCode).toBe(102);
      expect(result.protocol.statusReason).toBe('Inutilização de número homologado');
      expect(result.protocol.protocolNumber).toMatch(officialSimpleTypePattern('TProt'));
    }
  });

  it('pedido idêntico repetido devolve 563 com o protocolo do pedido anterior', async () => {
    const sefaz = new MockSefazProvider();
    const first = await sefaz.voidNumbers(voidRequest(INVOICE_NUMBER));
    const repeated = await sefaz.voidNumbers(voidRequest(INVOICE_NUMBER));

    expect(repeated).toMatchObject({ kind: 'VOIDED', protocol: { statusCode: 563 } });
    if (first.kind === 'VOIDED' && repeated.kind === 'VOIDED') {
      expect(repeated.protocol.protocolNumber).toBe(first.protocol.protocolNumber);
    }
  });

  it('faixa que cruza inutilização anterior é rejeitada com 256', async () => {
    const sefaz = new MockSefazProvider();
    await sefaz.voidNumbers(voidRequest(INVOICE_NUMBER));

    expect(await sefaz.voidNumbers(voidRequest(1520, 1530))).toEqual({
      kind: 'RANGE_ALREADY_VOIDED',
      statusCode: 256,
      statusReason: 'Rejeição: Uma NF-e da faixa já está inutilizada na Base de dados da SEFAZ',
    });
  });

  it('número usado por NF-e registrada é rejeitado com 241', async () => {
    const sefaz = new MockSefazProvider();
    await sefaz.authorize(authorization);

    expect(await sefaz.voidNumbers(voidRequest(INVOICE_NUMBER))).toMatchObject({
      kind: 'NUMBER_ALREADY_USED',
      statusCode: 241,
    });
  });

  it('autorização de número inutilizado é rejeitada com 206', async () => {
    const sefaz = new MockSefazProvider();
    await sefaz.voidNumbers(voidRequest(INVOICE_NUMBER));

    expect(await sefaz.authorize(authorization)).toEqual({
      kind: 'REJECTED',
      statusCode: 206,
      statusReason: 'Rejeição: NF-e já está inutilizada na Base de Dados da SEFAZ',
    });
  });
});

describe('nota retida na fila da SEFAZ (MOC 7.0, Anexo III, 2.3.3)', () => {
  it('inutilizada antes do processamento: a fila não gera autorização', async () => {
    const sefaz = new MockSefazProvider().scriptAuthorizations({ type: 'hold-in-queue' });

    expect(requiresReconciliation(await failure(sefaz.authorize(authorization)))).toBe(true);
    expect((await sefaz.queryProtocol(authorization)).kind).toBe('NOT_FOUND');
    expect((await sefaz.voidNumbers(voidRequest(INVOICE_NUMBER))).kind).toBe('VOIDED');

    expect(sefaz.releaseHeldAuthorizations()).toBe(0);
    expect((await sefaz.queryProtocol(authorization)).kind).toBe('NOT_FOUND');
  });

  it('processada antes da inutilização: a SEFAZ recusa inutilizar e a consulta acha a nota', async () => {
    const sefaz = new MockSefazProvider().scriptAuthorizations({ type: 'hold-in-queue' });
    await failure(sefaz.authorize(authorization));

    expect(sefaz.releaseHeldAuthorizations()).toBe(1);
    expect((await sefaz.voidNumbers(voidRequest(INVOICE_NUMBER))).kind).toBe('NUMBER_ALREADY_USED');
    expect((await sefaz.queryProtocol(authorization)).kind).toBe('AUTHORIZED');
  });
});

describe('falhas na inutilização', () => {
  it('resposta perdida: repetir o pedido é seguro e devolve o mesmo protocolo (563)', async () => {
    const sefaz = new MockSefazProvider().scriptVoids({ type: 'lose-response-after-processing' });

    expect(requiresReconciliation(await failure(sefaz.voidNumbers(voidRequest(INVOICE_NUMBER))))).toBe(
      true,
    );
    expect(await sefaz.voidNumbers(voidRequest(INVOICE_NUMBER))).toMatchObject({
      kind: 'VOIDED',
      protocol: { statusCode: 563 },
    });
    expect(sefaz.countCalls('NUMBER_VOID')).toBe(2);
  });

  it('recusa produção e pedido cuja faixa não corresponde ao XML', async () => {
    const sefaz = new MockSefazProvider();
    expect(
      await failure(sefaz.voidNumbers({ ...voidRequest(5), environment: Environment.Production })),
    ).toBeInstanceOf(ProviderConfigurationError);
    expect(await failure(sefaz.voidNumbers({ ...voidRequest(5), lastNumber: 6 }))).toBeInstanceOf(
      ProviderConfigurationError,
    );
    expect(sefaz.calls).toHaveLength(0);
  });
});

describe('interpretNumberVoidResponse', () => {
  const status = (statusCode: number) => ({ statusCode, statusReason: 'retorno' });
  const receivedAt = new Date('2026-09-12T15:00:00Z');

  it('102 com protocolo é inutilização homologada', () => {
    expect(
      interpretNumberVoidResponse({ status: status(102), protocolNumber: '135260000000001', receivedAt }),
    ).toMatchObject({ kind: 'VOIDED', protocol: { protocolNumber: '135260000000001' } });
  });

  it('563 com o nProt anterior confirma a inutilização; sem nProt, não presume', () => {
    expect(
      interpretNumberVoidResponse({ status: status(563), protocolNumber: '135260000000001', receivedAt })
        .kind,
    ).toBe('VOIDED');
    expect(interpretNumberVoidResponse({ status: status(563), receivedAt }).kind).toBe('UNRECOGNIZED');
  });

  it.each([
    [241, 'NUMBER_ALREADY_USED'],
    [256, 'RANGE_ALREADY_VOIDED'],
    [108, 'SERVICE_UNAVAILABLE'],
    [224, 'REJECTED'],
    [102, 'UNRECOGNIZED'],
    [107, 'UNRECOGNIZED'],
  ])('cStat %i sem protocolo vira %s', (code, kind) => {
    expect(interpretNumberVoidResponse({ status: status(code) }).kind).toBe(kind);
  });
});
