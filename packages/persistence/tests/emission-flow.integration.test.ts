/**
 * Fluxo completo sobre Postgres real: serviço de emissão, store com RLS, XML
 * montado e assinado de verdade, XSD oficial e SEFAZ simulada.
 */

import { fileURLToPath } from 'node:url';
import { NfeStatus, isValidAccessKey } from '@nfe/core';
import { EmissionService, type InvoiceReference, type ReconciliationPolicy } from '@nfe/emission';
import { MockSefazProvider } from '@nfe/sefaz';
import { verifyNfeSignature } from '@nfe/signer';
import { NfeSchemaValidator, PL_010D_INUTILIZATION } from '@nfe/xsd';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeDraft, schemaValidatorFor, testSigner } from '../../emission/tests/support/fixtures.js';
import { PostgresEmissionStore } from '../src/index.js';
import { createScope, createTestDatabase, type TenantScope, type TestDatabase } from './support/database.js';

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
const validator = new NfeSchemaValidator(repositoryRoot);
const JUSTIFICATION = 'NF-e pendente de retorno nao localizada na SEFAZ apos consultas';

// Sem espera: aqui o que se verifica é a persistência. Os intervalos da política
// são testados com relógio controlado em @nfe/emission.
const IMMEDIATE_POLICY: ReconciliationPolicy = {
  firstQueryDelayMs: 0,
  queryIntervalsMs: [0],
  notFoundQueriesBeforeVoid: 3,
  minimumAgeBeforeVoidMs: 0,
};

let database: TestDatabase;
let store: PostgresEmissionStore;
let signer: ReturnType<typeof testSigner>;
let scope: TenantScope;
let mock: MockSefazProvider;
let service: EmissionService;
let keySequence = 0;

beforeAll(async () => {
  database = await createTestDatabase();
  store = new PostgresEmissionStore(database.db);
  signer = testSigner();
});

beforeEach(async () => {
  scope = await createScope(database.db, 'fluxo');
  mock = new MockSefazProvider();
  service = new EmissionService({
    store,
    sefaz: mock,
    signer,
    schemaValidator: schemaValidatorFor(validator),
    reconciliationPolicy: IMMEDIATE_POLICY,
  });
});

afterAll(async () => {
  validator.dispose();
  await database.dispose();
});

async function newDraft(): Promise<InvoiceReference> {
  keySequence += 1;
  const { invoice } = await service.createDraft({
    ...scope,
    idempotencyKey: `fluxo-${keySequence}`,
    draft: makeDraft(),
  });
  return { tenantId: scope.tenantId, invoiceId: invoice.id };
}

async function attemptsOf(invoiceId: string) {
  const { rows } = await database.admin.query<{ operation: string; outcome: string | null }>(
    'SELECT operation, outcome FROM sefaz_attempts WHERE invoice_id = $1 ORDER BY started_at',
    [invoiceId],
  );
  return rows;
}

describe('emissão concorrente', () => {
  it('20 emissões simultâneas na mesma série: números 1..20, chaves distintas, XML válido e assinado', async () => {
    const references = await Promise.all(Array.from({ length: 20 }, () => newDraft()));
    const outcomes = await Promise.all(references.map((reference) => service.issue(reference)));

    expect(outcomes.every((outcome) => outcome.kind === 'QUEUED')).toBe(true);
    const invoices = outcomes.map((outcome) => outcome.invoice);
    expect(invoices.map((invoice) => invoice.number).sort((a, b) => a! - b!)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
    expect(new Set(invoices.map((invoice) => invoice.accessKey)).size).toBe(20);
    for (const invoice of invoices) {
      expect(isValidAccessKey(invoice.accessKey!)).toBe(true);
      expect(verifyNfeSignature(invoice.signedXml!).valid).toBe(true);
      expect(validator.validate(invoice.signedXml!).errors).toEqual([]);
    }

    const { rows } = await database.admin.query<{ next_number: number }>(
      'SELECT next_number FROM number_sequences WHERE issuer_id = $1',
      [scope.issuerId],
    );
    expect(rows).toEqual([{ next_number: 21 }]);
  });

  it('criações simultâneas com a mesma chave de idempotência geram um único documento', async () => {
    const draft = makeDraft();
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        service.createDraft({ ...scope, idempotencyKey: 'pedido-duplicado', draft }),
      ),
    );

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.invoice.id)).size).toBe(1);
  });
});

describe('inutilização de nota pendente de retorno', () => {
  async function pendingHeldInQueue(): Promise<InvoiceReference> {
    mock.scriptAuthorizations({ type: 'hold-in-queue' });
    const reference = await newDraft();
    await service.issue(reference);
    expect((await service.transmit(reference)).invoice.status).toBe(NfeStatus.PendingReconciliation);
    for (let query = 0; query < 3; query += 1) {
      expect((await service.reconcile(reference)).outcome).toBe('NOT_FOUND');
    }
    return reference;
  }

  it('inutilizada antes do processamento: protocolo gravado no banco e fila sem efeito', async () => {
    const reference = await pendingHeldInQueue();

    const outcome = await service.voidNumber({ ...reference, justification: JUSTIFICATION });
    expect(outcome).toMatchObject({
      outcome: 'VOIDED',
      voided: true,
      invoice: { status: NfeStatus.NumberVoided },
    });
    expect(mock.releaseHeldAuthorizations()).toBe(0);

    const { rows } = await database.admin.query<{ status: string; protocol_number: string | null }>(
      'SELECT status, protocol_number FROM number_voids WHERE invoice_id = $1',
      [reference.invoiceId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('VOIDED');
    expect(rows[0]?.protocol_number).toMatch(/^\d{15}$/);
    expect((await attemptsOf(reference.invoiceId)).map((attempt) => attempt.outcome)).toEqual([
      'NO_RESPONSE',
      'NOT_FOUND',
      'NOT_FOUND',
      'NOT_FOUND',
      'VOIDED',
    ]);

    const record = await store.findNumberVoid(reference.tenantId, reference.invoiceId);
    expect(validator.validate(record!.signedXml, PL_010D_INUTILIZATION).errors).toEqual([]);
  });

  it('processada antes da inutilização: a SEFAZ recusa (241) e a consulta autoriza', async () => {
    const reference = await pendingHeldInQueue();
    expect(mock.releaseHeldAuthorizations()).toBe(1);

    expect((await service.voidNumber({ ...reference, justification: JUSTIFICATION })).outcome).toBe(
      'NUMBER_ALREADY_USED',
    );
    expect((await store.findNumberVoid(reference.tenantId, reference.invoiceId))?.status).toBe('REJECTED');
    expect(await service.reconcile(reference)).toMatchObject({ outcome: 'AUTHORIZED', resolved: true });
  });
});

describe('desfecho desconhecido', () => {
  it('resposta perdida: pendente no banco, sem reenvio, resolvida por consulta', async () => {
    mock.scriptAuthorizations({ type: 'lose-response-after-processing' });
    const reference = await newDraft();
    await service.issue(reference);

    expect((await service.transmit(reference)).invoice.status).toBe(NfeStatus.PendingReconciliation);
    await expect(service.transmit(reference)).rejects.toThrow();

    const reconciled = await service.reconcile(reference);
    expect(reconciled).toMatchObject({ outcome: 'AUTHORIZED', resolved: true });
    expect(mock.countCalls('AUTHORIZATION')).toBe(1);

    const stored = await store.findInvoice(reference.tenantId, reference.invoiceId);
    expect(stored?.protocol?.protocolNumber).toMatch(/^\d{15}$/);
    expect(await attemptsOf(reference.invoiceId)).toEqual([
      { operation: 'AUTHORIZATION', outcome: 'NO_RESPONSE' },
      { operation: 'PROTOCOL_QUERY', outcome: 'AUTHORIZED' },
    ]);
  });

  it('processo que cai com a requisição em voo é recuperado como pendente', async () => {
    const reference = await newDraft();
    await service.issue(reference);
    await store.beginAttempt({
      ...reference,
      operation: 'AUTHORIZATION',
      path: [NfeStatus.Queued, NfeStatus.Sending],
    });

    const recovered = await service.recoverAbandonedAttempts({
      tenantId: scope.tenantId,
      startedBefore: new Date(Date.now() + 60_000),
    });
    expect(recovered.map((invoice) => invoice.status)).toEqual([NfeStatus.PendingReconciliation]);
    expect((await service.reconcile(reference)).outcome).toBe('NOT_FOUND');
    expect(await attemptsOf(reference.invoiceId)).toEqual([
      { operation: 'AUTHORIZATION', outcome: 'ABANDONED' },
      { operation: 'PROTOCOL_QUERY', outcome: 'NOT_FOUND' },
    ]);
  });
});
