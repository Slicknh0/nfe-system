/**
 * Store em memória para testes rápidos do serviço de emissão.
 *
 * Passa na mesma suíte de contrato que o adaptador Postgres. Se este fake
 * aceitar algo que o banco recusa, a suíte falha — é o que impede o teste
 * rápido de mentir.
 */

import { randomUUID } from 'node:crypto';
import { NfeStatus } from '@nfe/core';
import {
  ConcurrentModificationError,
  IdempotencyConflictError,
  InvoiceNotFoundError,
  MAX_INVOICE_NUMBER,
  NumberedInvoiceChangeError,
  SeriesExhaustedError,
  assertStatusPath,
  type AttemptCompletion,
  type AttemptOutcome,
  type AttemptRequest,
  type AttemptStart,
  type DraftCreation,
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
} from '../../src/index.js';
import type { SefazOperation } from '@nfe/sefaz';
import { KeyedMutex } from './keyed-mutex.js';

interface AttemptRow {
  readonly id: string;
  readonly tenantId: string;
  readonly invoiceId: string;
  readonly operation: SefazOperation;
  readonly startedAt: Date;
  readonly outcome?: AttemptOutcome;
}

type InvoiceChanges = Partial<
  Pick<
    InvoiceRecord,
    'draft' | 'series' | 'environment' | 'number' | 'accessKey' | 'signedXml' | 'protocol'
  >
>;

export class InMemoryEmissionStore implements EmissionStore {
  private readonly invoices = new Map<string, InvoiceRecord>();
  private readonly histories = new Map<string, StatusHistoryEntry[]>();
  private readonly sequences = new Map<string, number>();
  private readonly attempts = new Map<string, AttemptRow>();
  private readonly mutex = new KeyedMutex();
  private readonly now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  createDraft(input: NewDraft): Promise<DraftCreation> {
    return this.mutex.run<DraftCreation>(`idempotency:${input.tenantId}`, () => {
      const existing = [...this.invoices.values()].find(
        (invoice) =>
          invoice.tenantId === input.tenantId && invoice.idempotencyKey === input.idempotencyKey,
      );
      if (existing !== undefined) {
        if (existing.requestHash !== input.requestHash) {
          throw new IdempotencyConflictError(input.idempotencyKey);
        }
        return Promise.resolve({ invoice: existing, created: false });
      }

      const at = this.now();
      const invoice: InvoiceRecord = {
        id: randomUUID(),
        tenantId: input.tenantId,
        issuerId: input.issuerId,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        environment: input.draft.identification.environment,
        series: input.draft.identification.series,
        status: NfeStatus.Draft,
        version: 1,
        draft: input.draft,
        createdAt: at,
        updatedAt: at,
      };
      this.invoices.set(invoice.id, invoice);
      this.histories.set(invoice.id, [{ to: NfeStatus.Draft, occurredAt: at }]);
      return Promise.resolve({ invoice, created: true });
    });
  }

  findInvoice(tenantId: string, invoiceId: string): Promise<InvoiceRecord | undefined> {
    const invoice = this.invoices.get(invoiceId);
    return Promise.resolve(invoice?.tenantId === tenantId ? invoice : undefined);
  }

  findHistory(tenantId: string, invoiceId: string): Promise<readonly StatusHistoryEntry[]> {
    const invoice = this.invoices.get(invoiceId);
    return Promise.resolve(
      invoice?.tenantId === tenantId ? [...(this.histories.get(invoiceId) ?? [])] : [],
    );
  }

  reviseDraft(input: DraftRevision): Promise<InvoiceRecord> {
    return this.mutex.run(input.invoiceId, () => {
      assertStatusPath(input.path);
      const invoice = this.load(input);
      if (invoice.version !== input.expectedVersion) {
        throw new ConcurrentModificationError(
          input.invoiceId,
          `versão atual ${invoice.version}, esperada ${input.expectedVersion}`,
        );
      }
      const { series, environment } = input.draft.identification;
      if (
        invoice.number !== undefined &&
        (series !== invoice.series || environment !== invoice.environment)
      ) {
        throw new NumberedInvoiceChangeError();
      }
      return Promise.resolve(this.apply(invoice, input, { draft: input.draft, series, environment }));
    });
  }

  signWithNumber(
    input: TransitionRequest,
    build: (context: SigningContext) => Promise<SignedArtifact>,
  ): Promise<InvoiceRecord> {
    return this.mutex.run(input.invoiceId, async () => {
      assertStatusPath(input.path);
      const invoice = this.load(input);

      if (invoice.number !== undefined) {
        const artifact = await build({ invoice, number: invoice.number });
        return this.apply(invoice, input, {
          accessKey: artifact.accessKey,
          signedXml: artifact.signedXml,
        });
      }

      const sequenceKey = `${invoice.issuerId}|${invoice.environment}|${invoice.series}`;
      return this.mutex.run(`sequence:${sequenceKey}`, async () => {
        const number = this.sequences.get(sequenceKey) ?? 1;
        if (number > MAX_INVOICE_NUMBER) {
          throw new SeriesExhaustedError(invoice.series);
        }
        const artifact = await build({ invoice, number });
        this.sequences.set(sequenceKey, number + 1);
        return this.apply(invoice, input, {
          number,
          accessKey: artifact.accessKey,
          signedXml: artifact.signedXml,
        });
      });
    });
  }

  transition(input: TransitionRequest): Promise<InvoiceRecord> {
    return this.mutex.run(input.invoiceId, () => {
      assertStatusPath(input.path);
      return Promise.resolve(this.apply(this.load(input), input, {}));
    });
  }

  beginAttempt(input: AttemptRequest): Promise<AttemptStart> {
    return this.mutex.run(input.invoiceId, () => {
      assertStatusPath(input.path);
      const invoice = this.apply(this.load(input), input, {});
      const attemptId = randomUUID();
      this.attempts.set(attemptId, {
        id: attemptId,
        tenantId: input.tenantId,
        invoiceId: input.invoiceId,
        operation: input.operation,
        startedAt: this.now(),
      });
      return Promise.resolve({ invoice, attemptId });
    });
  }

  finishAttempt(input: AttemptCompletion): Promise<InvoiceRecord> {
    return this.mutex.run(input.invoiceId, () => {
      assertStatusPath(input.path);
      const current = this.load(input);
      const attempt = this.attempts.get(input.attemptId);
      if (attempt?.tenantId !== input.tenantId || attempt.invoiceId !== input.invoiceId) {
        throw new ConcurrentModificationError(input.invoiceId, 'tentativa inexistente');
      }
      if (attempt.outcome !== undefined) {
        throw new ConcurrentModificationError(input.invoiceId, 'tentativa já concluída');
      }
      const invoice = this.apply(
        current,
        input,
        input.protocol === undefined ? {} : { protocol: input.protocol },
      );
      this.attempts.set(attempt.id, { ...attempt, outcome: input.outcome });
      return Promise.resolve(invoice);
    });
  }

  findUnfinishedAttempts(input: UnfinishedAttemptQuery): Promise<readonly UnfinishedAttempt[]> {
    return Promise.resolve(
      [...this.attempts.values()]
        .filter(
          (attempt) =>
            attempt.tenantId === input.tenantId &&
            attempt.outcome === undefined &&
            attempt.startedAt < input.startedBefore,
        )
        .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
        .map((attempt) => ({
          attemptId: attempt.id,
          invoiceId: attempt.invoiceId,
          operation: attempt.operation,
          startedAt: attempt.startedAt,
        })),
    );
  }

  private load(request: TransitionRequest): InvoiceRecord {
    const invoice = this.invoices.get(request.invoiceId);
    if (invoice?.tenantId !== request.tenantId) {
      throw new InvoiceNotFoundError(request.invoiceId);
    }
    const expected = request.path[0];
    if (invoice.status !== expected) {
      throw new ConcurrentModificationError(
        request.invoiceId,
        `estado atual ${invoice.status}, esperado ${String(expected)}`,
      );
    }
    return invoice;
  }

  private apply(
    invoice: InvoiceRecord,
    request: TransitionRequest,
    changes: InvoiceChanges,
  ): InvoiceRecord {
    const finalStatus = assertStatusPath(request.path);
    const at = this.now();
    const updated: InvoiceRecord = {
      ...invoice,
      ...changes,
      ...(request.lastStatus === undefined ? {} : { lastStatus: request.lastStatus }),
      status: finalStatus,
      version: invoice.version + 1,
      updatedAt: at,
    };
    this.invoices.set(invoice.id, updated);

    const history = this.histories.get(invoice.id) ?? [];
    for (let index = 1; index < request.path.length; index += 1) {
      const isLast = index === request.path.length - 1;
      history.push({
        from: request.path[index - 1] as NfeStatus,
        to: request.path[index] as NfeStatus,
        occurredAt: at,
        ...(isLast && request.reason !== undefined ? { reason: request.reason } : {}),
      });
    }
    this.histories.set(invoice.id, history);
    return updated;
  }
}
