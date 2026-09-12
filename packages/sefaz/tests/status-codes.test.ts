import { describe, expect, it } from 'vitest';
import {
  SefazStatus,
  classifyProtocolStatus,
  interpretAuthorizationResponse,
  interpretProtocolQueryResponse,
  type InvoiceProtocol,
} from '../src/index.js';

const protocol = (statusCode: number): InvoiceProtocol => ({
  accessKey: '35260911222333000181550010000015231482139670',
  statusCode,
  statusReason: 'texto',
  protocolNumber: '135260000000001',
  receivedAt: new Date('2026-09-11T13:00:00Z'),
});

describe('classifyProtocolStatus — tabelas 4.4.1 a 4.4.3 do MOC 7.0, Anexo I', () => {
  it.each([100, 150])('%i é autorização', (code) => {
    expect(classifyProtocolStatus(code)).toBe('AUTHORIZED');
  });

  it.each([110, 301, 302, 303])('%i é denegação', (code) => {
    expect(classifyProtocolStatus(code)).toBe('DENIED');
  });

  it.each([204, 539])('%i é duplicidade, não rejeição comum', (code) => {
    expect(classifyProtocolStatus(code)).toBe('DUPLICATE');
  });

  it.each([142, 225, 539 - 1, 999])('%i é rejeição', (code) => {
    expect(classifyProtocolStatus(code)).toBe('REJECTED');
  });

  it.each([0, 99, 107, 124, 1000, 100.5])('%s fora das tabelas não é presumido rejeição', (code) => {
    expect(classifyProtocolStatus(code)).toBe('UNRECOGNIZED');
  });
});

describe('interpretAuthorizationResponse', () => {
  const batch = (statusCode: number) => ({ statusCode, statusReason: 'lote' });

  it('lote processado com protocolo 100 é autorização', () => {
    const result = interpretAuthorizationResponse({ batch: batch(104), protocol: protocol(100) });
    expect(result.kind).toBe('AUTHORIZED');
  });

  it('lote processado com protocolo 302 é denegação com protocolo', () => {
    const result = interpretAuthorizationResponse({ batch: batch(104), protocol: protocol(302) });
    expect(result).toMatchObject({ kind: 'DENIED', protocol: { protocolNumber: '135260000000001' } });
  });

  it('lote processado com protocolo 204 é duplicidade', () => {
    const result = interpretAuthorizationResponse({ batch: batch(104), protocol: protocol(204) });
    expect(result).toEqual({ kind: 'DUPLICATE', statusCode: 204, statusReason: 'texto' });
  });

  it('lote processado sem protocolo não tem desfecho reconhecível', () => {
    expect(interpretAuthorizationResponse({ batch: batch(104) }).kind).toBe('UNRECOGNIZED');
  });

  it.each([
    [103, 'IN_PROCESSING'],
    [105, 'IN_PROCESSING'],
    [108, 'SERVICE_UNAVAILABLE'],
    [109, 'SERVICE_UNAVAILABLE'],
    [225, 'REJECTED'],
    [107, 'UNRECOGNIZED'],
  ])('cStat %i do lote vira %s', (code, kind) => {
    expect(interpretAuthorizationResponse({ batch: batch(code) }).kind).toBe(kind);
  });
});

describe('interpretProtocolQueryResponse', () => {
  const status = (statusCode: number) => ({ statusCode, statusReason: 'consulta' });

  it('100 com protocolo é autorização', () => {
    expect(interpretProtocolQueryResponse({ status: status(100), protocol: protocol(100) }).kind).toBe(
      'AUTHORIZED',
    );
  });

  it('100 sem protocolo não é aceito como autorização', () => {
    expect(interpretProtocolQueryResponse({ status: status(100) }).kind).toBe('UNRECOGNIZED');
  });

  it.each([
    [SefazStatus.INVOICE_NOT_FOUND, 'NOT_FOUND'],
    [101, 'CANCELLED'],
    [151, 'CANCELLED'],
    [108, 'SERVICE_UNAVAILABLE'],
    [226, 'QUERY_REJECTED'],
    [104, 'UNRECOGNIZED'],
  ])('cStat %i vira %s', (code, kind) => {
    expect(interpretProtocolQueryResponse({ status: status(code) }).kind).toBe(kind);
  });
});
