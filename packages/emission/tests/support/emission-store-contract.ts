/**
 * Suíte de contrato de `EmissionStore`.
 *
 * Todo adaptador — memória, Postgres ou o que vier — roda exatamente estes
 * testes. As garantias que o serviço de emissão pressupõe (idempotência,
 * numeração sem repetição, compare-and-set, tentativa concluída uma única vez)
 * são verificadas aqui, e não presumidas.
 */

import { randomInt } from 'node:crypto';
import {
  InvalidTransitionError,
  NfeStatus,
  buildUnsignedInutilization,
  buildUnsignedNfe,
  parseAccessKey,
} from '@nfe/core';
import type { InvoiceProtocol, VoidProtocol } from '@nfe/sefaz';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ConcurrentModificationError,
  IdempotencyConflictError,
  InvoiceNotFoundError,
  NumberedInvoiceChangeError,
  completeDraft,
  draftRequestHash,
  type DraftDocument,
  type InvoiceRecord,
  type EmissionStore,
  type NumberVoidDraft,
  type SignedArtifact,
  type SigningContext,
} from '../../src/index.js';
import { makeDraft, withIdentification } from './fixtures.js';

export interface TenantScope {
  readonly tenantId: string;
  readonly issuerId: string;
}

export interface StoreContractContext {
  readonly store: EmissionStore;
  readonly tenantA: TenantScope;
  readonly tenantB: TenantScope;
}

const TO_QUEUED: readonly NfeStatus[] = [
  NfeStatus.Draft,
  NfeStatus.Validating,
  NfeStatus.Validated,
  NfeStatus.Signed,
  NfeStatus.Queued,
];

// `cNF` aleatório, como no serviço: a chave de acesso é única no país, e o
// Postgres recusa chave repetida mesmo entre tenants diferentes.
function artifact({ invoice, number }: SigningContext): Promise<SignedArtifact> {
  const unsigned = buildUnsignedNfe(
    completeDraft(invoice.draft, {
      number,
      randomCode: String(randomInt(0, 100_000_000)).padStart(8, '0'),
      issuedAt: new Date('2026-09-11T10:00:00-03:00'),
    }),
  );
  return Promise.resolve({ accessKey: unsigned.accessKey, signedXml: unsigned.xml });
}

export function describeEmissionStoreContract(
  label: string,
  createContext: () => Promise<StoreContractContext>,
): void {
  describe(`contrato EmissionStore — ${label}`, () => {
    let context: StoreContractContext;
    let keySequence = 0;

    beforeEach(async () => {
      context = await createContext();
    });

    const store = (): EmissionStore => context.store;

    async function createInvoice(
      scope: TenantScope = context.tenantA,
      draft: DraftDocument = makeDraft(),
      idempotencyKey = `pedido-${(keySequence += 1)}`,
    ): Promise<InvoiceRecord> {
      const { invoice } = await store().createDraft({
        ...scope,
        idempotencyKey,
        requestHash: draftRequestHash(scope.issuerId, draft),
        draft,
      });
      return invoice;
    }

    function sign(invoice: InvoiceRecord, path: readonly NfeStatus[] = TO_QUEUED) {
      return store().signWithNumber(
        { tenantId: invoice.tenantId, invoiceId: invoice.id, path },
        artifact,
      );
    }

    async function authorize(invoice: InvoiceRecord, protocol: InvoiceProtocol) {
      const { attemptId } = await store().beginAttempt({
        tenantId: invoice.tenantId,
        invoiceId: invoice.id,
        operation: 'AUTHORIZATION',
        path: [NfeStatus.Queued, NfeStatus.Sending],
      });
      return store().finishAttempt({
        tenantId: invoice.tenantId,
        invoiceId: invoice.id,
        attemptId,
        path: [NfeStatus.Sending, NfeStatus.Authorized],
        outcome: 'AUTHORIZED',
        lastStatus: { statusCode: protocol.statusCode, statusReason: protocol.statusReason },
        protocol,
      });
    }

    describe('rascunho e idempotência', () => {
      it('cria em DRAFT, com histórico inicial e conteúdo preservado', async () => {
        const draft = makeDraft();
        const invoice = await createInvoice(context.tenantA, draft);

        expect(invoice.status).toBe(NfeStatus.Draft);
        expect(invoice.number).toBeUndefined();

        const found = await store().findInvoice(context.tenantA.tenantId, invoice.id);
        expect(found?.id).toBe(invoice.id);
        expect(draftRequestHash(context.tenantA.issuerId, found!.draft)).toBe(invoice.requestHash);
        expect(found!.draft.items[0]!.unitPrice.toFixed(2)).toBe('49.90');

        const history = await store().findHistory(context.tenantA.tenantId, invoice.id);
        expect(history.map((entry) => entry.to)).toEqual([NfeStatus.Draft]);
      });

      it('mesma chave com o mesmo conteúdo devolve o documento existente', async () => {
        const draft = makeDraft();
        const first = await store().createDraft({
          ...context.tenantA,
          idempotencyKey: 'pedido-unico',
          requestHash: draftRequestHash(context.tenantA.issuerId, draft),
          draft,
        });
        const second = await store().createDraft({
          ...context.tenantA,
          idempotencyKey: 'pedido-unico',
          requestHash: draftRequestHash(context.tenantA.issuerId, draft),
          draft,
        });

        expect(first.created).toBe(true);
        expect(second.created).toBe(false);
        expect(second.invoice.id).toBe(first.invoice.id);
      });

      it('mesma chave com conteúdo diferente é conflito', async () => {
        await createInvoice(context.tenantA, makeDraft(), 'pedido-conflito');
        const other = withIdentification(makeDraft(), { operationNature: 'Outra natureza' });

        await expect(
          createInvoice(context.tenantA, other, 'pedido-conflito'),
        ).rejects.toBeInstanceOf(IdempotencyConflictError);
      });

      it('chave de idempotência é isolada por tenant', async () => {
        const a = await createInvoice(context.tenantA, makeDraft(), 'mesma-chave');
        const b = await createInvoice(context.tenantB, makeDraft(), 'mesma-chave');
        expect(b.id).not.toBe(a.id);
      });

      it('tenant não lê nem altera documento de outro tenant', async () => {
        const invoice = await createInvoice(context.tenantA);
        const foreign = context.tenantB.tenantId;

        expect(await store().findInvoice(foreign, invoice.id)).toBeUndefined();
        expect(await store().findHistory(foreign, invoice.id)).toEqual([]);
        await expect(
          store().transition({
            tenantId: foreign,
            invoiceId: invoice.id,
            path: [NfeStatus.Draft, NfeStatus.Validating],
          }),
        ).rejects.toBeInstanceOf(InvoiceNotFoundError);
      });
    });

    describe('numeração', () => {
      it('é sequencial por série, e cada série tem sua própria sequência', async () => {
        const first = await sign(await createInvoice());
        const second = await sign(await createInvoice());
        const otherSeries = await sign(
          await createInvoice(context.tenantA, withIdentification(makeDraft(), { series: 2 })),
        );

        expect([first.number, second.number, otherSeries.number]).toEqual([1, 2, 1]);
        expect(first.status).toBe(NfeStatus.Queued);
        expect(first.accessKey).toHaveLength(44);
        expect(first.signedXml).toContain(`Id="NFe${first.accessKey}"`);
      });

      it('falha na montagem não consome número nem altera o documento', async () => {
        const failing = await createInvoice();
        await expect(
          store().signWithNumber(
            { tenantId: failing.tenantId, invoiceId: failing.id, path: TO_QUEUED },
            () => Promise.reject(new Error('falha simulada na assinatura')),
          ),
        ).rejects.toThrow('falha simulada na assinatura');

        const unchanged = await store().findInvoice(failing.tenantId, failing.id);
        expect(unchanged?.status).toBe(NfeStatus.Draft);
        expect(unchanged?.number).toBeUndefined();
        expect(unchanged?.version).toBe(failing.version);

        expect((await sign(await createInvoice())).number).toBe(1);
      });

      it('emissões simultâneas na mesma série recebem números distintos e contíguos', async () => {
        const invoices = await Promise.all(
          Array.from({ length: 12 }, () => createInvoice()),
        );
        const signed = await Promise.all(invoices.map((invoice) => sign(invoice)));

        expect(signed.map((invoice) => invoice.number).sort((a, b) => a! - b!)).toEqual(
          Array.from({ length: 12 }, (_, index) => index + 1),
        );
      });

      it('documento já numerado mantém o número ao ser assinado de novo', async () => {
        const invoice = await sign(await createInvoice());
        const { attemptId } = await store().beginAttempt({
          tenantId: invoice.tenantId,
          invoiceId: invoice.id,
          operation: 'AUTHORIZATION',
          path: [NfeStatus.Queued, NfeStatus.Sending],
        });
        await store().finishAttempt({
          tenantId: invoice.tenantId,
          invoiceId: invoice.id,
          attemptId,
          path: [NfeStatus.Sending, NfeStatus.Rejected],
          outcome: 'REJECTED',
        });

        const resigned = await sign(invoice, [NfeStatus.Rejected, ...TO_QUEUED]);
        expect(resigned.number).toBe(invoice.number);
        expect((await sign(await createInvoice())).number).toBe(2);
      });

      it('recusa assinar quando o estado não é o esperado', async () => {
        const invoice = await sign(await createInvoice());
        await expect(sign(invoice)).rejects.toBeInstanceOf(ConcurrentModificationError);
      });
    });

    describe('transições', () => {
      it('caminho inválido é recusado e nada muda', async () => {
        const invoice = await createInvoice();
        await expect(
          store().transition({
            tenantId: invoice.tenantId,
            invoiceId: invoice.id,
            path: [NfeStatus.Draft, NfeStatus.Authorized],
          }),
        ).rejects.toBeInstanceOf(InvalidTransitionError);

        const unchanged = await store().findInvoice(invoice.tenantId, invoice.id);
        expect(unchanged?.status).toBe(NfeStatus.Draft);
        expect(unchanged?.version).toBe(invoice.version);
      });

      it('estado atual diferente do esperado é conflito', async () => {
        const invoice = await createInvoice();
        await expect(
          store().transition({
            tenantId: invoice.tenantId,
            invoiceId: invoice.id,
            path: [NfeStatus.Queued, NfeStatus.Sending],
          }),
        ).rejects.toBeInstanceOf(ConcurrentModificationError);
      });

      it('histórico registra cada salto, com o motivo no último', async () => {
        const invoice = await createInvoice();
        const updated = await store().transition({
          tenantId: invoice.tenantId,
          invoiceId: invoice.id,
          path: [NfeStatus.Draft, NfeStatus.Validating, NfeStatus.LocalValidationError],
          reason: 'CFOP incompatível',
        });

        expect(updated.version).toBe(invoice.version + 1);
        const history = await store().findHistory(invoice.tenantId, invoice.id);
        expect(history.map(({ from, to, reason }) => ({ from, to, reason }))).toEqual([
          { from: undefined, to: NfeStatus.Draft, reason: undefined },
          { from: NfeStatus.Draft, to: NfeStatus.Validating, reason: undefined },
          {
            from: NfeStatus.Validating,
            to: NfeStatus.LocalValidationError,
            reason: 'CFOP incompatível',
          },
        ]);
      });

      it('documento autorizado preserva protocolo e só aceita cancelamento', async () => {
        const invoice = await sign(await createInvoice());
        const protocol: InvoiceProtocol = {
          accessKey: invoice.accessKey!,
          statusCode: 100,
          statusReason: 'Autorizado o uso da NF-e',
          protocolNumber: '135260000000001',
          receivedAt: new Date('2026-09-11T13:00:05.000Z'),
          digestValue: 'ZGlnZXN0',
        };
        const authorized = await authorize(invoice, protocol);

        expect(authorized.status).toBe(NfeStatus.Authorized);
        const found = await store().findInvoice(invoice.tenantId, invoice.id);
        expect(found?.protocol).toEqual(protocol);
        expect(found?.lastStatus).toEqual({ statusCode: 100, statusReason: 'Autorizado o uso da NF-e' });

        await expect(
          store().transition({
            tenantId: invoice.tenantId,
            invoiceId: invoice.id,
            path: [NfeStatus.Authorized, NfeStatus.Draft],
          }),
        ).rejects.toBeInstanceOf(InvalidTransitionError);
      });
    });

    describe('tentativas de comunicação com a SEFAZ', () => {
      it('de duas tentativas simultâneas de envio, só uma começa', async () => {
        const invoice = await sign(await createInvoice());
        const begin = () =>
          store().beginAttempt({
            tenantId: invoice.tenantId,
            invoiceId: invoice.id,
            operation: 'AUTHORIZATION',
            path: [NfeStatus.Queued, NfeStatus.Sending],
          });

        const results = await Promise.allSettled([begin(), begin()]);
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        const rejected = results.find((result) => result.status === 'rejected');
        expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(
          ConcurrentModificationError,
        );
      });

      it('tentativa concluída não pode ser concluída de novo, mesmo sem mudança de estado', async () => {
        const invoice = await sign(await createInvoice());
        const sending = await store().beginAttempt({
          tenantId: invoice.tenantId,
          invoiceId: invoice.id,
          operation: 'AUTHORIZATION',
          path: [NfeStatus.Queued, NfeStatus.Sending],
        });
        await store().finishAttempt({
          tenantId: invoice.tenantId,
          invoiceId: invoice.id,
          attemptId: sending.attemptId,
          path: [NfeStatus.Sending, NfeStatus.CommunicationError, NfeStatus.PendingReconciliation],
          outcome: 'NO_RESPONSE',
        });

        const query = await store().beginAttempt({
          tenantId: invoice.tenantId,
          invoiceId: invoice.id,
          operation: 'PROTOCOL_QUERY',
          path: [NfeStatus.PendingReconciliation],
        });
        const finishQuery = () =>
          store().finishAttempt({
            tenantId: invoice.tenantId,
            invoiceId: invoice.id,
            attemptId: query.attemptId,
            path: [NfeStatus.PendingReconciliation],
            outcome: 'NOT_FOUND',
            lastStatus: {
              statusCode: 217,
              statusReason: 'Rejeição: NF-e não consta na base de dados da SEFAZ',
            },
          });

        await finishQuery();
        await expect(finishQuery()).rejects.toBeInstanceOf(ConcurrentModificationError);
      });

      it('lista apenas tentativas abertas iniciadas antes do instante informado', async () => {
        const invoice = await sign(await createInvoice());
        const { attemptId } = await store().beginAttempt({
          tenantId: invoice.tenantId,
          invoiceId: invoice.id,
          operation: 'AUTHORIZATION',
          path: [NfeStatus.Queued, NfeStatus.Sending],
        });
        const scope = { tenantId: invoice.tenantId };

        const open = await store().findUnfinishedAttempts({
          ...scope,
          startedBefore: new Date(Date.now() + 60_000),
        });
        expect(open.map((attempt) => [attempt.attemptId, attempt.invoiceId, attempt.operation])).toEqual([
          [attemptId, invoice.id, 'AUTHORIZATION'],
        ]);
        expect(
          await store().findUnfinishedAttempts({ ...scope, startedBefore: new Date(Date.now() - 60_000) }),
        ).toEqual([]);
        expect(
          await store().findUnfinishedAttempts({
            tenantId: context.tenantB.tenantId,
            startedBefore: new Date(Date.now() + 60_000),
          }),
        ).toEqual([]);

        await store().finishAttempt({
          tenantId: invoice.tenantId,
          invoiceId: invoice.id,
          attemptId,
          path: [NfeStatus.Sending, NfeStatus.Queued],
          outcome: 'NOT_SENT',
        });
        expect(
          await store().findUnfinishedAttempts({ ...scope, startedBefore: new Date(Date.now() + 60_000) }),
        ).toEqual([]);
      });
    });

    async function sendToPending(invoice: InvoiceRecord): Promise<InvoiceRecord> {
      const { attemptId } = await store().beginAttempt({
        tenantId: invoice.tenantId,
        invoiceId: invoice.id,
        operation: 'AUTHORIZATION',
        path: [NfeStatus.Queued, NfeStatus.Sending],
      });
      return store().finishAttempt({
        tenantId: invoice.tenantId,
        invoiceId: invoice.id,
        attemptId,
        path: [NfeStatus.Sending, NfeStatus.CommunicationError, NfeStatus.PendingReconciliation],
        outcome: 'NO_RESPONSE',
      });
    }

    function voidDraftFor(
      invoice: InvoiceRecord,
      justification = 'Numeracao nao utilizada por falha tecnica',
    ): NumberVoidDraft {
      const key = parseAccessKey(invoice.accessKey!);
      const unsigned = buildUnsignedInutilization({
        environment: invoice.environment,
        stateCode: key.cUF,
        year: key.year,
        cnpj: key.cnpj,
        series: key.series,
        firstNumber: key.number,
        lastNumber: key.number,
        justification,
      });
      return { year: key.year, justification, requestId: unsigned.id, signedXml: unsigned.xml };
    }

    const voidProtocol = (statusCode: number): VoidProtocol => ({
      statusCode,
      statusReason: statusCode === 102 ? 'Inutilização de número homologado' : 'Rejeição: repetido',
      protocolNumber: '135260000000077',
      receivedAt: new Date('2026-09-12T15:30:00.000Z'),
    });

    describe('consultas de apoio à reconciliação', () => {
      it('lista as tentativas do documento em ordem, com desfecho e código', async () => {
        const invoice = await sendToPending(await sign(await createInvoice()));
        const { attemptId } = await store().beginAttempt({
          tenantId: invoice.tenantId,
          invoiceId: invoice.id,
          operation: 'PROTOCOL_QUERY',
          path: [NfeStatus.PendingReconciliation],
        });
        await store().finishAttempt({
          tenantId: invoice.tenantId,
          invoiceId: invoice.id,
          attemptId,
          path: [NfeStatus.PendingReconciliation],
          outcome: 'NOT_FOUND',
          lastStatus: { statusCode: 217, statusReason: 'Rejeição: NF-e não consta na base de dados da SEFAZ' },
        });

        const attempts = await store().findAttempts(invoice.tenantId, invoice.id);
        expect(attempts.map((attempt) => [attempt.operation, attempt.outcome, attempt.statusCode])).toEqual([
          ['AUTHORIZATION', 'NO_RESPONSE', undefined],
          ['PROTOCOL_QUERY', 'NOT_FOUND', 217],
        ]);
        expect(attempts.every((attempt) => attempt.finishedAt instanceof Date)).toBe(true);
        expect(await store().findAttempts(context.tenantB.tenantId, invoice.id)).toEqual([]);
      });

      it('lista documentos por estado, apenas do tenant e respeitando o limite', async () => {
        const first = await sendToPending(await sign(await createInvoice()));
        const second = await sendToPending(await sign(await createInvoice()));
        await createInvoice();
        await sendToPending(await sign(await createInvoice(context.tenantB)));

        const query = { tenantId: context.tenantA.tenantId, statuses: [NfeStatus.PendingReconciliation] };
        const pending = await store().listInvoices({ ...query, limit: 10 });
        expect(pending.map((invoice) => invoice.id).sort()).toEqual([first.id, second.id].sort());
        expect(await store().listInvoices({ ...query, limit: 1 })).toHaveLength(1);
      });
    });

    describe('inutilização de numeração', () => {
      it('registra o pedido e, homologado, encerra o documento com o protocolo', async () => {
        const invoice = await sendToPending(await sign(await createInvoice()));
        const draft = voidDraftFor(invoice);
        const { attemptId } = await store().beginAttempt({
          tenantId: invoice.tenantId,
          invoiceId: invoice.id,
          operation: 'NUMBER_VOID',
          path: [NfeStatus.PendingReconciliation],
          numberVoid: draft,
        });

        const requested = await store().findNumberVoid(invoice.tenantId, invoice.id);
        expect(requested).toMatchObject({
          status: 'REQUESTED',
          requestId: draft.requestId,
          series: invoice.series,
          firstNumber: invoice.number,
          lastNumber: invoice.number,
          year: draft.year,
        });

        const protocol = voidProtocol(102);
        const voided = await store().finishAttempt({
          tenantId: invoice.tenantId,
          invoiceId: invoice.id,
          attemptId,
          path: [NfeStatus.PendingReconciliation, NfeStatus.NumberVoided],
          outcome: 'VOIDED',
          lastStatus: { statusCode: 102, statusReason: protocol.statusReason },
          numberVoid: { status: 'VOIDED', protocol },
        });

        expect(voided.status).toBe(NfeStatus.NumberVoided);
        const record = await store().findNumberVoid(invoice.tenantId, invoice.id);
        expect(record?.status).toBe('VOIDED');
        expect(record?.protocol).toEqual(protocol);
        expect(await store().findNumberVoid(context.tenantB.tenantId, invoice.id)).toBeUndefined();

        await expect(
          store().transition({
            tenantId: invoice.tenantId,
            invoiceId: invoice.id,
            path: [NfeStatus.NumberVoided, NfeStatus.Draft],
          }),
        ).rejects.toBeInstanceOf(InvalidTransitionError);
      });

      it('pedido sem resposta pode ser repetido e o registro é o mesmo', async () => {
        const invoice = await sendToPending(await sign(await createInvoice()));
        const first = await store().beginAttempt({
          tenantId: invoice.tenantId,
          invoiceId: invoice.id,
          operation: 'NUMBER_VOID',
          path: [NfeStatus.PendingReconciliation],
          numberVoid: voidDraftFor(invoice),
        });
        await store().finishAttempt({
          tenantId: invoice.tenantId,
          invoiceId: invoice.id,
          attemptId: first.attemptId,
          path: [NfeStatus.PendingReconciliation],
          outcome: 'NO_RESPONSE',
          numberVoid: { status: 'REQUESTED' },
        });

        const retry = await store().beginAttempt({
          tenantId: invoice.tenantId,
          invoiceId: invoice.id,
          operation: 'NUMBER_VOID',
          path: [NfeStatus.PendingReconciliation],
          numberVoid: voidDraftFor(invoice, 'Segunda tentativa de inutilizacao do numero'),
        });
        expect((await store().findNumberVoid(invoice.tenantId, invoice.id))?.justification).toBe(
          'Segunda tentativa de inutilizacao do numero',
        );

        await store().finishAttempt({
          tenantId: invoice.tenantId,
          invoiceId: invoice.id,
          attemptId: retry.attemptId,
          path: [NfeStatus.PendingReconciliation, NfeStatus.NumberVoided],
          outcome: 'VOIDED',
          lastStatus: { statusCode: 563, statusReason: 'Rejeição: repetido' },
          numberVoid: { status: 'VOIDED', protocol: voidProtocol(563) },
        });
        const record = await store().findNumberVoid(invoice.tenantId, invoice.id);
        expect(record).toMatchObject({ status: 'VOIDED', lastStatus: { statusCode: 563 } });
      });

      it('numeração já inutilizada não recebe novo pedido', async () => {
        const invoice = await sendToPending(await sign(await createInvoice()));
        const { attemptId } = await store().beginAttempt({
          tenantId: invoice.tenantId,
          invoiceId: invoice.id,
          operation: 'NUMBER_VOID',
          path: [NfeStatus.PendingReconciliation],
          numberVoid: voidDraftFor(invoice),
        });
        await store().finishAttempt({
          tenantId: invoice.tenantId,
          invoiceId: invoice.id,
          attemptId,
          path: [NfeStatus.PendingReconciliation, NfeStatus.NumberVoided],
          outcome: 'VOIDED',
          numberVoid: { status: 'VOIDED', protocol: voidProtocol(102) },
        });

        await expect(
          store().beginAttempt({
            tenantId: invoice.tenantId,
            invoiceId: invoice.id,
            operation: 'NUMBER_VOID',
            path: [NfeStatus.NumberVoided],
            numberVoid: voidDraftFor(invoice),
          }),
        ).rejects.toBeInstanceOf(ConcurrentModificationError);
      });
    });

    describe('revisão de rascunho', () => {
      it('exige a versão lida e incrementa a versão', async () => {
        const invoice = await createInvoice();
        const revised = withIdentification(makeDraft(), { operationNature: 'Venda revisada' });

        await expect(
          store().reviseDraft({
            tenantId: invoice.tenantId,
            invoiceId: invoice.id,
            path: [NfeStatus.Draft],
            expectedVersion: invoice.version + 7,
            draft: revised,
          }),
        ).rejects.toBeInstanceOf(ConcurrentModificationError);

        const updated = await store().reviseDraft({
          tenantId: invoice.tenantId,
          invoiceId: invoice.id,
          path: [NfeStatus.Draft],
          expectedVersion: invoice.version,
          draft: revised,
        });
        expect(updated.version).toBe(invoice.version + 1);
        expect(updated.draft.identification.operationNature).toBe('Venda revisada');
      });

      it('série não muda depois que o documento recebeu número', async () => {
        const invoice = await sign(await createInvoice());
        const failed = await store().transition({
          tenantId: invoice.tenantId,
          invoiceId: invoice.id,
          path: [NfeStatus.Queued, NfeStatus.Sending, NfeStatus.Rejected],
        });

        await expect(
          store().reviseDraft({
            tenantId: invoice.tenantId,
            invoiceId: invoice.id,
            path: [NfeStatus.Rejected, NfeStatus.Draft],
            expectedVersion: failed.version,
            draft: withIdentification(makeDraft(), { series: 9 }),
          }),
        ).rejects.toBeInstanceOf(NumberedInvoiceChangeError);
      });
    });
  });
}
