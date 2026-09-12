/**
 * Fluxo completo sobre Postgres real: serviço de emissão, store com RLS, XML
 * montado e assinado de verdade, XSD oficial e SEFAZ simulada.
 */

import { fileURLToPath } from 'node:url';
import { NfeStatus, isValidAccessKey } from '@nfe/core';
import { EmissionService, type InvoiceReference } from '@nfe/emission';
import { MockSefazProvider } from '@nfe/sefaz';
import { verifyNfeSignature } from '@nfe/signer';
import { NfeSchemaValidator } from '@nfe/xsd';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeDraft, testSigner } from '../../emission/tests/support/fixtures.js';
import { PostgresEmissionStore } from '../src/index.js';
import { createScope, createTestDatabase, type TenantScope, type TestDatabase } from './support/database.js';

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
const validator = new NfeSchemaValidator(repositoryRoot);

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
  service = new EmissionService({ store, sefaz: mock, signer, schemaValidator: validator });
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
