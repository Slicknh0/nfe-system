/**
 * `EmissionStore` sobre Postgres.
 *
 * Concorrência:
 * - o documento é travado com `SELECT ... FOR UPDATE` antes de qualquer
 *   mudança, e o estado atual é conferido contra `path[0]`;
 * - a sequência da série é travada da mesma forma, sempre DEPOIS do documento
 *   (ordem fixa, sem deadlock entre emissões), e só é incrementada se a
 *   montagem do XML concluir dentro da mesma transação;
 * - a conclusão de tentativa usa `WHERE finished_at IS NULL`, então uma
 *   resposta tardia e a recuperação de tentativa abandonada nunca aplicam os
 *   dois desfechos.
 *
 * Passa na mesma suíte de contrato do store em memória.
 */

import { NfeStatus } from '@nfe/core';
import {
  ConcurrentModificationError,
  IdempotencyConflictError,
  InvoiceNotFoundError,
  MAX_INVOICE_NUMBER,
  NumberedInvoiceChangeError,
  SeriesExhaustedError,
  assertStatusPath,
  decodeDocument,
  encodeDocument,
  type AttemptCompletion,
  type AttemptRequest,
  type AttemptStart,
  type DraftCreation,
  type DraftDocument,
  type DraftRevision,
  type EmissionStore,
  type InvoiceRecord,
  type NewDraft,
  type SignedArtifact,
  type SigningContext,
  type StatusHistoryEntry,
  type TransitionRequest,
  type UnfinishedAttempt,
  type UnfinishedAttemptQuery,
} from '@nfe/emission';
import type { EnvironmentCode, InvoiceProtocol, SefazOperation } from '@nfe/sefaz';
import { and, asc, eq, isNull, lt, sql } from 'drizzle-orm';
import { isUuid, withTenant, type Database, type Transaction } from './database.js';
import { translateDatabaseError } from './errors.js';
import { invoiceStatusHistory, invoices, numberSequences, sefazAttempts } from './schema.js';

type InvoiceRow = typeof invoices.$inferSelect;
type InvoiceChanges = Partial<
  Pick<
    typeof invoices.$inferInsert,
    | 'draft'
    | 'series'
    | 'environment'
    | 'number'
    | 'accessKey'
    | 'signedXml'
    | 'protocolNumber'
    | 'protocolStatusCode'
    | 'protocolStatusReason'
    | 'protocolReceivedAt'
    | 'protocolDigestValue'
  >
>;

const STATUSES = new Set<string>(Object.values(NfeStatus));
const OPERATIONS = new Set<string>(['AUTHORIZATION', 'PROTOCOL_QUERY']);

export class PostgresEmissionStore implements EmissionStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async createDraft(input: NewDraft): Promise<DraftCreation> {
    if (!isUuid(input.issuerId)) {
      throw new Error('Identificador de emitente inválido.');
    }
    return await this.inTenant(input.tenantId, async (tx) => {
      const { environment, series } = input.draft.identification;
      const [inserted] = await tx
        .insert(invoices)
        .values({
          tenantId: input.tenantId,
          issuerId: input.issuerId,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
          environment,
          series,
          status: NfeStatus.Draft,
          draft: encodeDocument(input.draft),
        })
        .onConflictDoNothing({ target: [invoices.tenantId, invoices.idempotencyKey] })
        .returning();

      if (inserted !== undefined) {
        await tx.insert(invoiceStatusHistory).values({
          tenantId: input.tenantId,
          invoiceId: inserted.id,
          toStatus: NfeStatus.Draft,
        });
        return { invoice: toRecord(inserted), created: true };
      }

      const [existing] = await tx
        .select()
        .from(invoices)
        .where(
          and(
            eq(invoices.tenantId, input.tenantId),
            eq(invoices.idempotencyKey, input.idempotencyKey),
          ),
        );
      if (existing === undefined) {
        throw new Error('Conflito de idempotência sem documento visível.');
      }
      if (existing.requestHash !== input.requestHash) {
        throw new IdempotencyConflictError(input.idempotencyKey);
      }
      return { invoice: toRecord(existing), created: false };
    });
  }

  async findInvoice(tenantId: string, invoiceId: string): Promise<InvoiceRecord | undefined> {
    if (!isUuid(tenantId) || !isUuid(invoiceId)) {
      return undefined;
    }
    const [row] = await this.inTenant(tenantId, (tx) =>
      tx
        .select()
        .from(invoices)
        .where(and(eq(invoices.id, invoiceId), eq(invoices.tenantId, tenantId)))
        .then((rows) => rows),
    );
    return row === undefined ? undefined : toRecord(row);
  }

  async findHistory(tenantId: string, invoiceId: string): Promise<readonly StatusHistoryEntry[]> {
    if (!isUuid(tenantId) || !isUuid(invoiceId)) {
      return [];
    }
    const rows = await this.inTenant(tenantId, (tx) =>
      tx
        .select()
        .from(invoiceStatusHistory)
        .where(
          and(
            eq(invoiceStatusHistory.invoiceId, invoiceId),
            eq(invoiceStatusHistory.tenantId, tenantId),
          ),
        )
        .orderBy(asc(invoiceStatusHistory.id))
        .then((result) => result),
    );
    return rows.map((row) => ({
      ...(row.fromStatus === null ? {} : { from: toStatus(row.fromStatus) }),
      to: toStatus(row.toStatus),
      ...(row.reason === null ? {} : { reason: row.reason }),
      occurredAt: row.occurredAt,
    }));
  }

  async reviseDraft(input: DraftRevision): Promise<InvoiceRecord> {
    assertStatusPath(input.path);
    return await this.inInvoice(input, async (tx, row) => {
      if (row.version !== input.expectedVersion) {
        throw new ConcurrentModificationError(
          input.invoiceId,
          `versão atual ${row.version}, esperada ${input.expectedVersion}`,
        );
      }
      const { series, environment } = input.draft.identification;
      if (row.number !== null && (series !== row.series || environment !== row.environment)) {
        throw new NumberedInvoiceChangeError();
      }
      return await applyPath(tx, row, input, {
        draft: encodeDocument(input.draft),
        series,
        environment,
      });
    });
  }

  async signWithNumber(
    input: TransitionRequest,
    build: (context: SigningContext) => Promise<SignedArtifact>,
  ): Promise<InvoiceRecord> {
    assertStatusPath(input.path);
    return await this.inInvoice(input, async (tx, row) => {
      const invoice = toRecord(row);

      if (row.number !== null) {
        const artifact = await build({ invoice, number: row.number });
        return await applyPath(tx, row, input, {
          accessKey: artifact.accessKey,
          signedXml: artifact.signedXml,
        });
      }

      const sequence = and(
        eq(numberSequences.issuerId, row.issuerId),
        eq(numberSequences.environment, row.environment),
        eq(numberSequences.model, row.model),
        eq(numberSequences.series, row.series),
      );
      await tx
        .insert(numberSequences)
        .values({
          tenantId: row.tenantId,
          issuerId: row.issuerId,
          environment: row.environment,
          model: row.model,
          series: row.series,
        })
        .onConflictDoNothing();
      const [locked] = await tx
        .select({ nextNumber: numberSequences.nextNumber })
        .from(numberSequences)
        .where(sequence)
        .for('update');
      if (locked === undefined) {
        throw new Error('Sequência de numeração não encontrada após criação.');
      }

      const number = locked.nextNumber;
      if (number > MAX_INVOICE_NUMBER) {
        throw new SeriesExhaustedError(row.series);
      }

      // Se `build` lançar, a transação inteira é desfeita: o número não é consumido.
      const artifact = await build({ invoice, number });

      await tx
        .update(numberSequences)
        .set({ nextNumber: number + 1, updatedAt: sql`now()` })
        .where(sequence);
      return await applyPath(tx, row, input, {
        number,
        accessKey: artifact.accessKey,
        signedXml: artifact.signedXml,
      });
    });
  }

  async transition(input: TransitionRequest): Promise<InvoiceRecord> {
    assertStatusPath(input.path);
    return await this.inInvoice(input, (tx, row) => applyPath(tx, row, input, {}));
  }

  async beginAttempt(input: AttemptRequest): Promise<AttemptStart> {
    assertStatusPath(input.path);
    let attemptId = '';
    const invoice = await this.inInvoice(input, async (tx, row) => {
      const updated = await applyPath(tx, row, input, {});
      const [attempt] = await tx
        .insert(sefazAttempts)
        .values({ tenantId: row.tenantId, invoiceId: row.id, operation: input.operation })
        .returning({ id: sefazAttempts.id });
      if (attempt === undefined) {
        throw new Error('Tentativa não registrada.');
      }
      attemptId = attempt.id;
      return updated;
    });
    return { invoice, attemptId };
  }

  async finishAttempt(input: AttemptCompletion): Promise<InvoiceRecord> {
    assertStatusPath(input.path);
    return await this.inInvoice(input, async (tx, row) => {
      const [finished] = isUuid(input.attemptId)
        ? await tx
            .update(sefazAttempts)
            .set({
              finishedAt: sql`clock_timestamp()`,
              outcome: input.outcome,
              statusCode: input.lastStatus?.statusCode ?? null,
              statusReason: input.lastStatus?.statusReason ?? null,
              detail: input.reason ?? null,
            })
            .where(
              and(
                eq(sefazAttempts.id, input.attemptId),
                eq(sefazAttempts.tenantId, input.tenantId),
                eq(sefazAttempts.invoiceId, input.invoiceId),
                isNull(sefazAttempts.finishedAt),
              ),
            )
            .returning({ id: sefazAttempts.id })
        : [];
      if (finished === undefined) {
        throw new ConcurrentModificationError(input.invoiceId, 'tentativa inexistente ou já concluída');
      }
      return await applyPath(tx, row, input, protocolChanges(input.protocol));
    });
  }

  async findUnfinishedAttempts(input: UnfinishedAttemptQuery): Promise<readonly UnfinishedAttempt[]> {
    if (!isUuid(input.tenantId)) {
      return [];
    }
    const rows = await this.inTenant(input.tenantId, (tx) =>
      tx
        .select()
        .from(sefazAttempts)
        .where(
          and(
            eq(sefazAttempts.tenantId, input.tenantId),
            isNull(sefazAttempts.finishedAt),
            lt(sefazAttempts.startedAt, input.startedBefore),
          ),
        )
        .orderBy(asc(sefazAttempts.startedAt))
        .then((result) => result),
    );
    return rows.map((row) => ({
      attemptId: row.id,
      invoiceId: row.invoiceId,
      operation: toOperation(row.operation),
      startedAt: row.startedAt,
    }));
  }

  private async inTenant<T>(tenantId: string, work: (tx: Transaction) => Promise<T>): Promise<T> {
    try {
      return await withTenant(this.db, tenantId, work);
    } catch (error) {
      throw translateDatabaseError(error);
    }
  }

  /** Transação com o documento travado e o estado atual conferido. */
  private async inInvoice(
    request: TransitionRequest,
    work: (tx: Transaction, row: InvoiceRow) => Promise<InvoiceRow>,
  ): Promise<InvoiceRecord> {
    if (!isUuid(request.tenantId) || !isUuid(request.invoiceId)) {
      throw new InvoiceNotFoundError(request.invoiceId);
    }
    const row = await this.inTenant(request.tenantId, async (tx) => {
      const [locked] = await tx
        .select()
        .from(invoices)
        .where(and(eq(invoices.id, request.invoiceId), eq(invoices.tenantId, request.tenantId)))
        .for('update');
      if (locked === undefined) {
        throw new InvoiceNotFoundError(request.invoiceId);
      }
      const expected = request.path[0];
      if (toStatus(locked.status) !== expected) {
        throw new ConcurrentModificationError(
          request.invoiceId,
          `estado atual ${locked.status}, esperado ${String(expected)}`,
        );
      }
      return await work(tx, locked);
    });
    return toRecord(row);
  }
}

async function applyPath(
  tx: Transaction,
  row: InvoiceRow,
  request: TransitionRequest,
  changes: InvoiceChanges,
): Promise<InvoiceRow> {
  const finalStatus = assertStatusPath(request.path);
  const [updated] = await tx
    .update(invoices)
    .set({
      ...changes,
      ...(request.lastStatus === undefined
        ? {}
        : {
            lastStatusCode: request.lastStatus.statusCode,
            lastStatusReason: request.lastStatus.statusReason,
          }),
      status: finalStatus,
      version: sql`${invoices.version} + 1`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(invoices.id, row.id), eq(invoices.version, row.version)))
    .returning();
  if (updated === undefined) {
    throw new ConcurrentModificationError(row.id, 'versão alterada durante a transação');
  }

  const lastHop = request.path.length - 1;
  const hops = request.path.slice(1).map((to, index) => ({
    tenantId: row.tenantId,
    invoiceId: row.id,
    fromStatus: request.path[index] ?? null,
    toStatus: to,
    reason: index + 1 === lastHop ? (request.reason ?? null) : null,
  }));
  if (hops.length > 0) {
    await tx.insert(invoiceStatusHistory).values(hops);
  }
  return updated;
}

function protocolChanges(protocol: InvoiceProtocol | undefined): InvoiceChanges {
  if (protocol === undefined) {
    return {};
  }
  return {
    protocolNumber: protocol.protocolNumber,
    protocolStatusCode: protocol.statusCode,
    protocolStatusReason: protocol.statusReason,
    protocolReceivedAt: protocol.receivedAt,
    protocolDigestValue: protocol.digestValue ?? null,
  };
}

function toStatus(value: string): NfeStatus {
  if (!STATUSES.has(value)) {
    throw new Error(`Estado desconhecido no banco: ${value}.`);
  }
  return value as NfeStatus;
}

function toOperation(value: string): SefazOperation {
  if (!OPERATIONS.has(value)) {
    throw new Error(`Operação desconhecida no banco: ${value}.`);
  }
  return value as SefazOperation;
}

function toEnvironment(value: number): EnvironmentCode {
  if (value !== 1 && value !== 2) {
    throw new Error(`Ambiente desconhecido no banco: ${value}.`);
  }
  return value;
}

function toRecord(row: InvoiceRow): InvoiceRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    issuerId: row.issuerId,
    idempotencyKey: row.idempotencyKey,
    requestHash: row.requestHash,
    environment: toEnvironment(row.environment),
    series: row.series,
    status: toStatus(row.status),
    version: row.version,
    draft: decodeDocument(row.draft) as DraftDocument,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.number === null ? {} : { number: row.number }),
    ...(row.accessKey === null ? {} : { accessKey: row.accessKey }),
    ...(row.signedXml === null ? {} : { signedXml: row.signedXml }),
    ...(row.lastStatusCode === null || row.lastStatusReason === null
      ? {}
      : { lastStatus: { statusCode: row.lastStatusCode, statusReason: row.lastStatusReason } }),
    ...protocolOf(row),
  };
}

function protocolOf(row: InvoiceRow): { protocol?: InvoiceProtocol } {
  if (
    row.accessKey === null ||
    row.protocolNumber === null ||
    row.protocolStatusCode === null ||
    row.protocolStatusReason === null ||
    row.protocolReceivedAt === null
  ) {
    return {};
  }
  return {
    protocol: {
      accessKey: row.accessKey,
      statusCode: row.protocolStatusCode,
      statusReason: row.protocolStatusReason,
      protocolNumber: row.protocolNumber,
      receivedAt: row.protocolReceivedAt,
      ...(row.protocolDigestValue === null ? {} : { digestValue: row.protocolDigestValue }),
    },
  };
}
