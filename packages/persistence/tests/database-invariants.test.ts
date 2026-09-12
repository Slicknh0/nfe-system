/**
 * Invariantes garantidas pelo próprio Postgres, exercitadas com SQL direto —
 * sem passar pelo store nem pela máquina de estados da aplicação. É o cenário
 * de defeito na aplicação ou de alguém executando SQL à mão.
 */

import { NfeStatus, buildUnsignedNfe, calculateCnpjCheckDigits, canTransition } from '@nfe/core';
import { completeDraft, draftRequestHash } from '@nfe/emission';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeDraft } from '../../emission/tests/support/fixtures.js';
import {
  PersistenceInvariantError,
  PostgresEmissionStore,
  UnsafeDatabaseRoleError,
  assertRestrictedRole,
} from '../src/index.js';
import { createScope, createTestDatabase, type TenantScope, type TestDatabase } from './support/database.js';

let database: TestDatabase;
let store: PostgresEmissionStore;
let tenantA: TenantScope;
let tenantB: TenantScope;
let keySequence = 0;

beforeAll(async () => {
  database = await createTestDatabase();
  store = new PostgresEmissionStore(database.db);
  tenantA = await createScope(database.db, 'A');
  tenantB = await createScope(database.db, 'B', `B2C3D4E5F6G7${calculateCnpjCheckDigits('B2C3D4E5F6G7')}`);
});

afterAll(async () => {
  await database.dispose();
});

async function draftInvoice(scope: TenantScope = tenantA) {
  const draft = makeDraft();
  keySequence += 1;
  const { invoice } = await store.createDraft({
    ...scope,
    idempotencyKey: `invariante-${keySequence}`,
    requestHash: draftRequestHash(scope.issuerId, draft),
    draft,
  });
  return invoice;
}

async function queuedInvoice(scope: TenantScope = tenantA) {
  const invoice = await draftInvoice(scope);
  return store.signWithNumber(
    {
      tenantId: scope.tenantId,
      invoiceId: invoice.id,
      path: [NfeStatus.Draft, NfeStatus.Validating, NfeStatus.Validated, NfeStatus.Signed, NfeStatus.Queued],
    },
    ({ invoice: current, number }) => {
      const unsigned = buildUnsignedNfe(
        completeDraft(current.draft, {
          number,
          randomCode: '48213967',
          issuedAt: new Date('2026-09-11T10:00:00-03:00'),
        }),
      );
      return Promise.resolve({ accessKey: unsigned.accessKey, signedXml: unsigned.xml });
    },
  );
}

async function sendToPending(scope: TenantScope, invoiceId: string) {
  const { attemptId } = await store.beginAttempt({
    tenantId: scope.tenantId,
    invoiceId,
    operation: 'AUTHORIZATION',
    path: [NfeStatus.Queued, NfeStatus.Sending],
  });
  return { attemptId, invoice: await store.finishAttempt({
    tenantId: scope.tenantId,
    invoiceId,
    attemptId,
    path: [NfeStatus.Sending, NfeStatus.CommunicationError, NfeStatus.PendingReconciliation],
    outcome: 'NO_RESPONSE',
  }) };
}

async function authorizedInvoice() {
  const invoice = await queuedInvoice();
  const { attemptId } = await store.beginAttempt({
    tenantId: tenantA.tenantId,
    invoiceId: invoice.id,
    operation: 'AUTHORIZATION',
    path: [NfeStatus.Queued, NfeStatus.Sending],
  });
  return store.finishAttempt({
    tenantId: tenantA.tenantId,
    invoiceId: invoice.id,
    attemptId,
    path: [NfeStatus.Sending, NfeStatus.Authorized],
    outcome: 'AUTHORIZED',
    protocol: {
      accessKey: invoice.accessKey!,
      statusCode: 100,
      statusReason: 'Autorizado o uso da NF-e',
      protocolNumber: '135260000000001',
      receivedAt: new Date(),
    },
  });
}

/** Executa SQL como a aplicação, no escopo do tenant, e desfaz ou confirma. */
async function asTenant(
  tenantId: string | undefined,
  statement: string,
  params: unknown[] = [],
  { commit = false } = {},
): Promise<pg.QueryResult> {
  const client = await database.app.connect();
  try {
    await client.query('BEGIN');
    if (tenantId !== undefined) {
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    }
    const result = await client.query(statement, params);
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function sqlState(operation: Promise<unknown>): Promise<string | undefined> {
  try {
    await operation;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe('papel da aplicação', () => {
  it('não é superusuário nem ignora RLS', async () => {
    await expect(assertRestrictedRole(database.app)).resolves.toBeUndefined();
    await expect(assertRestrictedRole(database.admin)).rejects.toBeInstanceOf(UnsafeDatabaseRoleError);
  });

  it('não tem permissão para excluir documento nem reescrever histórico', async () => {
    const invoice = await draftInvoice();
    expect(await sqlState(asTenant(tenantA.tenantId, 'DELETE FROM invoices WHERE id = $1', [invoice.id]))).toBe(
      '42501',
    );
    expect(
      await sqlState(
        asTenant(tenantA.tenantId, "UPDATE invoice_status_history SET reason = 'x' WHERE invoice_id = $1", [invoice.id]),
      ),
    ).toBe('42501');
  });
});

describe('isolamento entre tenants (RLS)', () => {
  it('outro tenant não vê o documento, e sem tenant configurado nada é visível', async () => {
    const invoice = await draftInvoice();
    const count = 'SELECT count(*)::int AS total FROM invoices WHERE id = $1';

    expect((await asTenant(tenantA.tenantId, count, [invoice.id])).rows[0]).toEqual({ total: 1 });
    expect((await asTenant(tenantB.tenantId, count, [invoice.id])).rows[0]).toEqual({ total: 0 });
    expect((await asTenant(undefined, count, [invoice.id])).rows[0]).toEqual({ total: 0 });
  });

  it('recusa gravar linha com tenant diferente do configurado', async () => {
    const insert = `INSERT INTO invoices (tenant_id, issuer_id, idempotency_key, request_hash, environment, series, status, draft)
      VALUES ($1, $2, 'intruso', repeat('a', 64), 2, 1, 'DRAFT', '{}')`;
    expect(await sqlState(asTenant(tenantB.tenantId, insert, [tenantA.tenantId, tenantA.issuerId]))).toBe('42501');
  });

  it('outro tenant não altera documento alheio: o UPDATE simplesmente não alcança a linha', async () => {
    const invoice = await draftInvoice();
    const result = await asTenant(tenantB.tenantId, "UPDATE invoices SET status = 'VALIDATING' WHERE id = $1", [
      invoice.id,
    ]);
    expect(result.rowCount).toBe(0);
  });
});

describe('documento autorizado', () => {
  it('não volta para rascunho nem tem o XML alterado', async () => {
    const invoice = await authorizedInvoice();
    expect(
      await sqlState(asTenant(tenantA.tenantId, "UPDATE invoices SET status = 'DRAFT' WHERE id = $1", [invoice.id])),
    ).toBe('NFE02');
    expect(
      await sqlState(
        asTenant(tenantA.tenantId, "UPDATE invoices SET signed_xml = signed_xml || ' ' WHERE id = $1", [invoice.id]),
      ),
    ).toBe('NFE02');
  });

  it('aceita apenas a passagem para cancelado', async () => {
    const invoice = await authorizedInvoice();
    const result = await asTenant(tenantA.tenantId, "UPDATE invoices SET status = 'CANCELLED' WHERE id = $1", [
      invoice.id,
    ]);
    expect(result.rowCount).toBe(1);
  });

  it('nem o superusuário exclui documento fiscal', async () => {
    const invoice = await authorizedInvoice();
    expect(await sqlState(database.admin.query('DELETE FROM invoices WHERE id = $1', [invoice.id]))).toBe('NFE02');
  });
});

describe('reconciliação pendente', () => {
  it('o banco aceita exatamente as saídas que a máquina de estados de @nfe/core aceita', async () => {
    const queued = await queuedInvoice();
    const { invoice } = await sendToPending(tenantA, queued.id);

    for (const target of Object.values(NfeStatus)) {
      if (target === NfeStatus.PendingReconciliation) {
        continue;
      }
      // Protocolo preenchido para que as CHECKs de protocolo não mascarem o trigger.
      const state = await sqlState(
        asTenant(
          tenantA.tenantId,
          `UPDATE invoices SET status = $2, protocol_number = '135260000000009', protocol_status_code = 100,
             protocol_status_reason = 'x', protocol_received_at = now() WHERE id = $1`,
          [invoice.id, target],
        ),
      );
      const allowedByCore = canTransition(NfeStatus.PendingReconciliation, target);
      expect({ target, rejected: state === 'NFE03' }).toEqual({ target, rejected: !allowedByCore });
      if (allowedByCore) {
        expect({ target, state }).toEqual({ target, state: undefined });
      }
    }
  });
});

describe('número e conteúdo transmitido', () => {
  it('número consumido não muda', async () => {
    const invoice = await queuedInvoice();
    expect(
      await sqlState(asTenant(tenantA.tenantId, 'UPDATE invoices SET number = number + 100 WHERE id = $1', [invoice.id])),
    ).toBe('NFE04');
  });

  it('XML de documento enfileirado não muda', async () => {
    const invoice = await queuedInvoice();
    expect(
      await sqlState(
        asTenant(tenantA.tenantId, "UPDATE invoices SET signed_xml = signed_xml || ' ' WHERE id = $1", [invoice.id]),
      ),
    ).toBe('NFE05');
  });

  it('o store traduz a violação para PersistenceInvariantError', async () => {
    const invoice = await queuedInvoice();
    const tampering = new PostgresEmissionStore(database.db);
    // Força um caminho que a aplicação nunca montaria: reassinar documento já enfileirado.
    await expect(
      tampering.signWithNumber(
        { tenantId: tenantA.tenantId, invoiceId: invoice.id, path: [NfeStatus.Queued] },
        () => Promise.resolve({ accessKey: invoice.accessKey!, signedXml: `${invoice.signedXml!} ` }),
      ),
    ).rejects.toBeInstanceOf(PersistenceInvariantError);
  });
});

describe('trilhas somente inserção', () => {
  it('histórico não é alterado nem pelo superusuário', async () => {
    const invoice = await draftInvoice();
    expect(
      await sqlState(
        database.admin.query("UPDATE invoice_status_history SET reason = 'x' WHERE invoice_id = $1", [invoice.id]),
      ),
    ).toBe('NFE01');
    expect(
      await sqlState(database.admin.query('DELETE FROM invoice_status_history WHERE invoice_id = $1', [invoice.id])),
    ).toBe('NFE01');
  });

  it('tentativa concluída não é reescrita', async () => {
    const queued = await queuedInvoice();
    const { attemptId } = await sendToPending(tenantA, queued.id);
    expect(
      await sqlState(
        asTenant(tenantA.tenantId, "UPDATE sefaz_attempts SET outcome = 'AUTHORIZED' WHERE id = $1", [attemptId]),
      ),
    ).toBe('NFE06');
    expect(await sqlState(database.admin.query('DELETE FROM sefaz_attempts WHERE id = $1', [attemptId]))).toBe(
      'NFE06',
    );
  });
});
