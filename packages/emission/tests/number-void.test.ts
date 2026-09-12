/**
 * Política de reconciliação e inutilização de numeração, com XML real
 * (montagem, assinatura, XSD oficial) e SEFAZ simulada que retém notas na fila.
 */

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { InvalidInutilizationRequestError, NfeStatus } from '@nfe/core';
import { MockSefazProvider, type MockAuthorizationBehavior } from '@nfe/sefaz';
import { verifyInutilizationSignature } from '@nfe/signer';
import { NfeSchemaValidator, PL_010D_INUTILIZATION } from '@nfe/xsd';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EmissionService,
  OperationNotAllowedError,
  VoidNotYetAllowedError,
  planReconciliation,
  type AttemptOutcome,
  type AttemptSummary,
  type Clock,
  type InvoiceRecord,
  type InvoiceReference,
  type ReconciliationPolicy,
  type XmlSigner,
} from '../src/index.js';
import { makeDraft, schemaValidatorFor, testSigner } from './support/fixtures.js';
import { InMemoryEmissionStore } from './support/in-memory-store.js';

const MINUTE = 60_000;
const JUSTIFICATION = 'NF-e pendente de retorno nao localizada na SEFAZ apos consultas';

const policy: ReconciliationPolicy = {
  firstQueryDelayMs: MINUTE,
  queryIntervalsMs: [2 * MINUTE],
  notFoundQueriesBeforeVoid: 3,
  minimumAgeBeforeVoidMs: 60 * MINUTE,
};

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
const validator = new NfeSchemaValidator(repositoryRoot);
const scope = { tenantId: 'tenant-a', issuerId: 'issuer-a' };
let signer: XmlSigner;

beforeAll(() => {
  signer = testSigner();
});

afterAll(() => validator.dispose());

class ManualClock implements Clock {
  private current = new Date();

  now(): Date {
    return new Date(this.current.getTime());
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

function setup() {
  const clock = new ManualClock();
  const store = new InMemoryEmissionStore(() => clock.now());
  const mock = new MockSefazProvider({ now: () => clock.now() });
  const service = new EmissionService({
    store,
    sefaz: mock,
    signer,
    schemaValidator: schemaValidatorFor(validator),
    clock,
    reconciliationPolicy: policy,
  });
  let sequence = 0;

  async function queued(): Promise<InvoiceReference> {
    sequence += 1;
    const { invoice } = await service.createDraft({
      ...scope,
      idempotencyKey: `pedido-${sequence}`,
      draft: makeDraft(),
    });
    const reference = { tenantId: scope.tenantId, invoiceId: invoice.id };
    expect((await service.issue(reference)).kind).toBe('QUEUED');
    return reference;
  }

  async function pending(behavior: MockAuthorizationBehavior): Promise<InvoiceReference> {
    const reference = await queued();
    mock.scriptAuthorizations(behavior);
    expect((await service.transmit(reference)).invoice.status).toBe(NfeStatus.PendingReconciliation);
    return reference;
  }

  /** Três consultas com 217 no ritmo da política, e a idade mínima cumprida. */
  async function exhaustQueries(): Promise<void> {
    for (const wait of [MINUTE, 2 * MINUTE, 2 * MINUTE]) {
      clock.advance(wait);
      const report = await service.runReconciliationCycle({ tenantId: scope.tenantId });
      expect(report.queried.map((result) => result.outcome)).toEqual(['NOT_FOUND']);
    }
    clock.advance(60 * MINUTE);
  }

  return { clock, store, mock, service, queued, pending, exhaustQueries };
}

describe('planReconciliation', () => {
  const sentAt = new Date('2026-09-12T13:00:00.000Z');
  const at = (minutes: number) => new Date(sentAt.getTime() + minutes * MINUTE);

  const invoice = (status: NfeStatus): InvoiceRecord => ({
    id: 'documento',
    tenantId: scope.tenantId,
    issuerId: scope.issuerId,
    idempotencyKey: 'pedido',
    requestHash: 'hash',
    environment: 2,
    series: 1,
    status,
    version: 5,
    draft: makeDraft(),
    createdAt: sentAt,
    updatedAt: sentAt,
  });

  const send: AttemptSummary = { attemptId: randomUUID(), operation: 'AUTHORIZATION', startedAt: sentAt };
  const query = (minutes: number, outcome: AttemptOutcome): AttemptSummary => ({
    attemptId: randomUUID(),
    operation: 'PROTOCOL_QUERY',
    startedAt: at(minutes),
    finishedAt: at(minutes),
    outcome,
  });
  const pendingInvoice = invoice(NfeStatus.PendingReconciliation);

  it('espera o primeiro intervalo depois do envio sem resposta', () => {
    expect(planReconciliation(pendingInvoice, [send], at(0.5), policy)).toEqual({
      action: 'WAIT',
      notBefore: at(1),
    });
    expect(planReconciliation(pendingInvoice, [send], at(1), policy)).toEqual({ action: 'QUERY_NOW' });
  });

  it('depois de cada consulta, espera o intervalo seguinte', () => {
    expect(planReconciliation(pendingInvoice, [send, query(1, 'NOT_FOUND')], at(2), policy)).toEqual({
      action: 'WAIT',
      notBefore: at(3),
    });
  });

  it('libera a inutilização só com consultas suficientes e idade mínima', () => {
    const attempts = [send, query(1, 'NOT_FOUND'), query(3, 'NOT_FOUND'), query(5, 'NOT_FOUND')];
    expect(planReconciliation(pendingInvoice, attempts, at(30), policy).action).toBe('QUERY_NOW');
    expect(planReconciliation(pendingInvoice, attempts, at(60), policy)).toEqual({
      action: 'VOID_ALLOWED',
      notFoundQueries: 3,
    });
  });

  it('resposta que contradiz "não consta" zera a contagem', () => {
    const attempts = [
      send,
      query(1, 'NOT_FOUND'),
      query(3, 'NOT_FOUND'),
      query(5, 'QUERY_REJECTED'),
      query(7, 'NOT_FOUND'),
    ];
    expect(planReconciliation(pendingInvoice, attempts, at(120), policy).action).toBe('QUERY_NOW');
  });

  it('falha técnica na consulta não conta nem zera', () => {
    const attempts = [
      send,
      query(1, 'NOT_FOUND'),
      query(3, 'NO_RESPONSE'),
      query(5, 'NOT_FOUND'),
      query(7, 'NOT_FOUND'),
    ];
    expect(planReconciliation(pendingInvoice, attempts, at(120), policy).action).toBe('VOID_ALLOWED');
  });

  it('consultas anteriores ao último envio não contam', () => {
    const earlier = (minutes: number): AttemptSummary => ({
      ...query(minutes, 'NOT_FOUND'),
      startedAt: new Date(sentAt.getTime() - minutes * MINUTE),
    });
    const attempts = [earlier(30), earlier(20), earlier(10), send];
    expect(planReconciliation(pendingInvoice, attempts, at(120), policy)).toEqual({ action: 'QUERY_NOW' });
  });

  it('nota em processamento nunca libera inutilização; documento resolvido não tem plano', () => {
    const attempts = [send, query(1, 'NOT_FOUND'), query(3, 'NOT_FOUND'), query(5, 'NOT_FOUND')];
    expect(planReconciliation(invoice(NfeStatus.Processing), attempts, at(120), policy).action).toBe(
      'QUERY_NOW',
    );
    expect(planReconciliation(invoice(NfeStatus.Authorized), attempts, at(120), policy).action).toBe(
      'NOT_APPLICABLE',
    );
  });
});

describe('ciclo de reconciliação', () => {
  it('respeita a espera e resolve a pendência que a SEFAZ autorizou', async () => {
    const { clock, service, pending, mock } = setup();
    const reference = await pending({ type: 'lose-response-after-processing' });

    const early = await service.runReconciliationCycle({ tenantId: scope.tenantId });
    expect(early).toEqual({ queried: [], waiting: 1, voidAllowed: [] });

    clock.advance(MINUTE);
    const report = await service.runReconciliationCycle({ tenantId: scope.tenantId });
    expect(report.queried).toHaveLength(1);
    expect(report.queried[0]).toMatchObject({ outcome: 'AUTHORIZED', resolved: true });
    expect(report.queried[0]?.invoice.id).toBe(reference.invoiceId);
    expect(mock.countCalls('AUTHORIZATION')).toBe(1);
  });
});

describe('inutilização de nota pendente de retorno', () => {
  it('nota que nunca chegou: 217 repetido, inutilização liberada pela política e homologada', async () => {
    const { clock, service, store, pending, mock } = setup();
    const reference = await pending({ type: 'lose-request' });

    clock.advance(MINUTE);
    await service.runReconciliationCycle({ tenantId: scope.tenantId });
    await expect(service.voidNumber({ ...reference, justification: JUSTIFICATION })).rejects.toBeInstanceOf(
      VoidNotYetAllowedError,
    );

    clock.advance(2 * MINUTE);
    await service.runReconciliationCycle({ tenantId: scope.tenantId });
    clock.advance(2 * MINUTE);
    await service.runReconciliationCycle({ tenantId: scope.tenantId });
    await expect(service.voidNumber({ ...reference, justification: JUSTIFICATION })).rejects.toBeInstanceOf(
      VoidNotYetAllowedError,
    );

    clock.advance(60 * MINUTE);
    expect((await service.runReconciliationCycle({ tenantId: scope.tenantId })).voidAllowed).toEqual([
      reference.invoiceId,
    ]);

    const outcome = await service.voidNumber({ ...reference, justification: JUSTIFICATION });
    expect(outcome).toMatchObject({
      outcome: 'VOIDED',
      voided: true,
      invoice: { status: NfeStatus.NumberVoided, lastStatus: { statusCode: 102 } },
    });

    const record = await store.findNumberVoid(reference.tenantId, reference.invoiceId);
    expect(record).toMatchObject({ status: 'VOIDED', protocol: { statusCode: 102 } });
    expect(validator.validate(record!.signedXml, PL_010D_INUTILIZATION).errors).toEqual([]);
    expect(verifyInutilizationSignature(record!.signedXml).valid).toBe(true);
    expect(mock.countCalls('AUTHORIZATION')).toBe(1);
    await expect(service.reconcile(reference)).rejects.toBeInstanceOf(OperationNotAllowedError);
  });

  it('nota retida na fila e processada antes: a SEFAZ recusa inutilizar (241) e a consulta autoriza', async () => {
    const { service, store, pending, mock, exhaustQueries } = setup();
    const reference = await pending({ type: 'hold-in-queue' });
    await exhaustQueries();

    expect(mock.releaseHeldAuthorizations()).toBe(1);
    const refused = await service.voidNumber({ ...reference, justification: JUSTIFICATION });

    expect(refused).toMatchObject({
      outcome: 'NUMBER_ALREADY_USED',
      voided: false,
      invoice: { status: NfeStatus.PendingReconciliation },
    });
    expect((await store.findNumberVoid(reference.tenantId, reference.invoiceId))?.status).toBe('REJECTED');
    expect(await service.reconcile(reference)).toMatchObject({ outcome: 'AUTHORIZED', resolved: true });
  });

  it('nota retida na fila e inutilizada antes: a fila não gera autorização', async () => {
    const { service, pending, mock, exhaustQueries, store } = setup();
    const reference = await pending({ type: 'hold-in-queue' });
    await exhaustQueries();

    expect((await service.voidNumber({ ...reference, justification: JUSTIFICATION })).voided).toBe(true);
    expect(mock.releaseHeldAuthorizations()).toBe(0);

    const invoice = await store.findInvoice(reference.tenantId, reference.invoiceId);
    const query = await mock.queryProtocol({ environment: invoice!.environment, accessKey: invoice!.accessKey! });
    expect(query.kind).toBe('NOT_FOUND');
  });

  it('resposta da inutilização perdida: repetir é seguro e a SEFAZ devolve o protocolo anterior (563)', async () => {
    const { service, store, pending, mock, exhaustQueries } = setup();
    const reference = await pending({ type: 'lose-request' });
    await exhaustQueries();
    mock.scriptVoids({ type: 'lose-response-after-processing' });

    const lost = await service.voidNumber({ ...reference, justification: JUSTIFICATION });
    expect(lost).toMatchObject({
      outcome: 'NO_RESPONSE',
      voided: false,
      invoice: { status: NfeStatus.PendingReconciliation },
    });
    expect((await store.findNumberVoid(reference.tenantId, reference.invoiceId))?.status).toBe('REQUESTED');

    const retried = await service.voidNumber({ ...reference, justification: JUSTIFICATION });
    expect(retried).toMatchObject({ outcome: 'VOIDED', voided: true });
    expect(await store.findNumberVoid(reference.tenantId, reference.invoiceId)).toMatchObject({
      status: 'VOIDED',
      protocol: { statusCode: 563 },
    });
  });

  it('processo que cai durante a inutilização: a recuperação não muda o estado e o pedido é repetido', async () => {
    const { clock, service, store, pending, exhaustQueries } = setup();
    const reference = await pending({ type: 'lose-request' });
    await exhaustQueries();
    const invoice = await store.findInvoice(reference.tenantId, reference.invoiceId);
    await store.beginAttempt({
      ...reference,
      operation: 'NUMBER_VOID',
      path: [NfeStatus.PendingReconciliation],
      numberVoid: {
        year: 2026,
        justification: JUSTIFICATION,
        requestId: `ID35${'0'.repeat(41)}`,
        signedXml: invoice!.signedXml!,
      },
    });

    clock.advance(MINUTE);
    const recovered = await service.recoverAbandonedAttempts({
      tenantId: scope.tenantId,
      startedBefore: clock.now(),
    });
    expect(recovered.map((item) => item.status)).toEqual([NfeStatus.PendingReconciliation]);
    expect((await store.findNumberVoid(reference.tenantId, reference.invoiceId))?.status).toBe('REQUESTED');

    expect((await service.voidNumber({ ...reference, justification: JUSTIFICATION })).voided).toBe(true);
  });
});

describe('inutilização fora da reconciliação', () => {
  it('nota rejeitada tem o número inutilizado sem esperar a política', async () => {
    const { service, queued, mock } = setup();
    const reference = await queued();
    mock.scriptAuthorizations({ type: 'reject', statusCode: 999, statusReason: 'Rejeição de teste' });
    expect((await service.transmit(reference)).invoice.status).toBe(NfeStatus.Rejected);

    expect(await service.voidNumber({ ...reference, justification: JUSTIFICATION })).toMatchObject({
      outcome: 'VOIDED',
      voided: true,
    });
    await expect(service.issue(reference)).rejects.toBeInstanceOf(OperationNotAllowedError);
  });

  it('documento sem número, enfileirado ou autorizado não tem numeração inutilizada', async () => {
    const { service, queued } = setup();
    const { invoice } = await service.createDraft({ ...scope, idempotencyKey: 'sem-numero', draft: makeDraft() });
    await expect(
      service.voidNumber({ tenantId: scope.tenantId, invoiceId: invoice.id, justification: JUSTIFICATION }),
    ).rejects.toBeInstanceOf(OperationNotAllowedError);

    const waiting = await queued();
    await expect(service.voidNumber({ ...waiting, justification: JUSTIFICATION })).rejects.toBeInstanceOf(
      OperationNotAllowedError,
    );

    await service.transmit(waiting);
    await expect(service.voidNumber({ ...waiting, justification: JUSTIFICATION })).rejects.toBeInstanceOf(
      OperationNotAllowedError,
    );
  });

  it('justificativa inválida é recusada antes de gravar ou chamar a SEFAZ', async () => {
    const { service, store, queued, mock } = setup();
    const reference = await queued();
    mock.scriptAuthorizations({ type: 'reject', statusCode: 999, statusReason: 'Rejeição de teste' });
    await service.transmit(reference);

    await expect(service.voidNumber({ ...reference, justification: 'curta' })).rejects.toBeInstanceOf(
      InvalidInutilizationRequestError,
    );
    expect(mock.countCalls('NUMBER_VOID')).toBe(0);
    expect(await store.findNumberVoid(reference.tenantId, reference.invoiceId)).toBeUndefined();
    expect(
      (await store.findAttempts(reference.tenantId, reference.invoiceId)).map((attempt) => attempt.operation),
    ).toEqual(['AUTHORIZATION']);
  });
});
