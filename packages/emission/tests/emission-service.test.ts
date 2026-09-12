/**
 * Serviço de emissão ponta a ponta, com XML real: montagem pelo `@nfe/core`,
 * assinatura pelo `@nfe/signer`, validação no XSD oficial e SEFAZ simulada.
 * Só a persistência é em memória — a versão Postgres roda em `@nfe/persistence`.
 */

import { fileURLToPath } from 'node:url';
import { Environment, NfeStatus, isValidAccessKey } from '@nfe/core';
import {
  MockSefazProvider,
  ProviderConfigurationError,
  type AuthorizationResult,
  type SefazProvider,
} from '@nfe/sefaz';
import { verifyNfeSignature } from '@nfe/signer';
import { NfeSchemaValidator } from '@nfe/xsd';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeItem } from '../../core/tests/fixtures/nfe-document.js';
import { createTestCredentials } from '../../signer/tests/support/credentials.js';
import {
  EmissionService,
  IdempotencyConflictError,
  InvalidIdempotencyKeyError,
  OperationNotAllowedError,
  type DraftDocument,
  type InvoiceReference,
  type SchemaValidator,
  type XmlSigner,
} from '../src/index.js';
import { makeDraft, testSigner, withIdentification } from './support/fixtures.js';
import { InMemoryEmissionStore } from './support/in-memory-store.js';

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
const validator = new NfeSchemaValidator(repositoryRoot);
const scope = { tenantId: 'tenant-a', issuerId: 'issuer-a' };
let signer: XmlSigner;

beforeAll(() => {
  signer = testSigner();
});

afterAll(() => validator.dispose());

interface SetupOptions {
  readonly sefaz?: SefazProvider;
  readonly signer?: XmlSigner;
  readonly schemaValidator?: SchemaValidator;
  readonly store?: InMemoryEmissionStore;
}

function setup(options: SetupOptions = {}) {
  const store = options.store ?? new InMemoryEmissionStore();
  const mock = new MockSefazProvider();
  const service = new EmissionService({
    store,
    sefaz: options.sefaz ?? mock,
    signer: options.signer ?? signer,
    schemaValidator: options.schemaValidator ?? validator,
  });
  let sequence = 0;

  async function draft(content: DraftDocument = makeDraft()): Promise<InvoiceReference> {
    sequence += 1;
    const { invoice } = await service.createDraft({
      ...scope,
      idempotencyKey: `pedido-${sequence}`,
      draft: content,
    });
    return { tenantId: scope.tenantId, invoiceId: invoice.id };
  }

  async function queued(content?: DraftDocument): Promise<InvoiceReference> {
    const reference = await draft(content);
    expect((await service.issue(reference)).kind).toBe('QUEUED');
    return reference;
  }

  async function statuses(reference: InvoiceReference): Promise<NfeStatus[]> {
    return (await store.findHistory(reference.tenantId, reference.invoiceId)).map((entry) => entry.to);
  }

  return { store, mock, service, draft, queued, statuses };
}

function stubProvider(result: AuthorizationResult | Error): SefazProvider {
  return {
    name: 'stub',
    authorize: () => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)),
    queryProtocol: () => Promise.reject(new Error('consulta não roteirizada')),
  };
}

describe('emissão autorizada', () => {
  it('rascunho → número → XML assinado válido → autorização com protocolo', async () => {
    const { service, store, queued, statuses, mock } = setup();
    const reference = await queued();

    const issued = await store.findInvoice(reference.tenantId, reference.invoiceId);
    expect(issued?.number).toBe(1);
    expect(isValidAccessKey(issued!.accessKey!)).toBe(true);
    expect(verifyNfeSignature(issued!.signedXml!).valid).toBe(true);
    expect(validator.validate(issued!.signedXml!).valid).toBe(true);

    const transmission = await service.transmit(reference);

    expect(transmission.outcome).toBe('AUTHORIZED');
    expect(transmission.invoice.status).toBe(NfeStatus.Authorized);
    expect(transmission.invoice.protocol?.accessKey).toBe(issued!.accessKey);
    expect(transmission.invoice.lastStatus?.statusCode).toBe(100);
    expect(mock.countCalls('AUTHORIZATION')).toBe(1);
    expect(await statuses(reference)).toEqual([
      NfeStatus.Draft,
      NfeStatus.Validating,
      NfeStatus.Validated,
      NfeStatus.Signed,
      NfeStatus.Queued,
      NfeStatus.Sending,
      NfeStatus.Authorized,
    ]);
  });

  it('criação é idempotente e recusa reuso da chave com outro conteúdo', async () => {
    const { service } = setup();
    const input = { ...scope, idempotencyKey: 'pedido-42', draft: makeDraft() };

    const first = await service.createDraft(input);
    const second = await service.createDraft(input);
    expect(second).toMatchObject({ created: false, invoice: { id: first.invoice.id } });

    await expect(
      service.createDraft({ ...input, draft: withIdentification(makeDraft(), { series: 3 }) }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(service.createDraft({ ...input, idempotencyKey: 'com espaço' })).rejects.toBeInstanceOf(
      InvalidIdempotencyKeyError,
    );
  });
});

describe('validação local', () => {
  it('XML recusado pelo XSD vira LOCAL_VALIDATION_ERROR e não consome número', async () => {
    const store = new InMemoryEmissionStore();
    const rejecting: SchemaValidator = {
      validate: () => ({
        valid: false,
        errors: [{ technicalMessage: 'Element xNome: pattern', explanation: 'Nome inválido' }],
      }),
    };
    const failing = setup({ store, schemaValidator: rejecting });
    const reference = await failing.draft();

    const outcome = await failing.service.issue(reference);
    expect(outcome.kind).toBe('LOCAL_VALIDATION_ERROR');
    if (outcome.kind === 'LOCAL_VALIDATION_ERROR') {
      expect(outcome.problems[0]).toContain('Nome inválido');
      expect(outcome.invoice.number).toBeUndefined();
    }

    const healthy = setup({ store });
    const next = await healthy.queued();
    expect((await store.findInvoice(next.tenantId, next.invoiceId))?.number).toBe(1);
  });

  it('dado fiscal inválido é corrigido por revisão e emitido com o número ainda livre', async () => {
    const { service, store, draft } = setup();
    const reference = await draft(makeDraft({ items: [makeItem({ description: 'Camiseta — algodão' })] }));

    const failed = await service.issue(reference);
    expect(failed.kind).toBe('LOCAL_VALIDATION_ERROR');

    await service.reviseDraft({ ...reference, expectedVersion: failed.invoice.version, draft: makeDraft() });
    const issued = await service.issue(reference);

    expect(issued.kind).toBe('QUEUED');
    expect(issued.invoice.number).toBe(1);
    expect((await store.findHistory(reference.tenantId, reference.invoiceId)).at(-1)?.to).toBe(
      NfeStatus.Queued,
    );
  });

  it('certificado vencido impede a emissão sem consumir número', async () => {
    const expired = testSigner(
      createTestCredentials({
        notBefore: new Date('2020-01-01T00:00:00Z'),
        notAfter: new Date('2021-01-01T00:00:00Z'),
      }),
    );
    const { service, draft } = setup({ signer: expired });

    const outcome = await service.issue(await draft());
    expect(outcome.kind).toBe('LOCAL_VALIDATION_ERROR');
    expect(outcome.invoice.number).toBeUndefined();
  });
});

describe('respostas de negócio da SEFAZ', () => {
  it('rejeição permite revisar e reemitir com o mesmo número', async () => {
    const { service, queued, mock, store } = setup();
    mock.scriptAuthorizations({ type: 'reject', statusCode: 999, statusReason: 'Rejeição de teste' });
    const reference = await queued();

    const rejected = await service.transmit(reference);
    expect(rejected.outcome).toBe('REJECTED');
    expect(rejected.invoice.lastStatus).toEqual({ statusCode: 999, statusReason: 'Rejeição de teste' });

    await service.reviseDraft({ ...reference, expectedVersion: rejected.invoice.version, draft: makeDraft() });
    const reissued = await service.issue(reference);
    expect(reissued.invoice.number).toBe(1);

    expect((await service.transmit(reference)).outcome).toBe('AUTHORIZED');
    expect(mock.countCalls('AUTHORIZATION')).toBe(2);
    expect((await store.findInvoice(reference.tenantId, reference.invoiceId))?.status).toBe(
      NfeStatus.Authorized,
    );
  });

  it('denegação é terminal', async () => {
    const { service, queued, mock } = setup();
    mock.scriptAuthorizations({ type: 'deny', statusCode: 301 });
    const reference = await queued();

    const denied = await service.transmit(reference);
    expect(denied.invoice.status).toBe(NfeStatus.Denied);
    expect(denied.invoice.protocol?.statusCode).toBe(301);
    await expect(service.transmit(reference)).rejects.toBeInstanceOf(OperationNotAllowedError);
    await expect(service.issue(reference)).rejects.toBeInstanceOf(OperationNotAllowedError);
  });
});

describe('falhas técnicas', () => {
  it('falha comprovadamente anterior ao envio devolve à fila, e o reenvio é seguro', async () => {
    const { service, queued, mock } = setup();
    mock.scriptAuthorizations({ type: 'fail-before-sending' });
    const reference = await queued();

    const failed = await service.transmit(reference);
    expect(failed).toMatchObject({ outcome: 'NOT_SENT', invoice: { status: NfeStatus.Queued } });
    expect((await service.transmit(reference)).outcome).toBe('AUTHORIZED');
  });

  it('serviço paralisado (108) devolve à fila', async () => {
    const { service, queued, mock } = setup();
    mock.scriptAuthorizations({ type: 'service-unavailable' });

    const outcome = await service.transmit(await queued());
    expect(outcome).toMatchObject({ outcome: 'SERVICE_UNAVAILABLE', invoice: { status: NfeStatus.Queued } });
  });

  it('resposta perdida depois de autorizar: não retransmite, reconcilia por consulta', async () => {
    const { service, queued, mock, statuses } = setup();
    mock.scriptAuthorizations({ type: 'lose-response-after-processing' });
    const reference = await queued();

    const lost = await service.transmit(reference);
    expect(lost).toMatchObject({
      outcome: 'NO_RESPONSE',
      invoice: { status: NfeStatus.PendingReconciliation },
    });
    await expect(service.transmit(reference)).rejects.toBeInstanceOf(OperationNotAllowedError);
    await expect(service.issue(reference)).rejects.toBeInstanceOf(OperationNotAllowedError);

    const reconciled = await service.reconcile(reference);
    expect(reconciled).toMatchObject({ outcome: 'AUTHORIZED', resolved: true });
    expect(reconciled.invoice.protocol?.protocolNumber).toMatch(/^\d{15}$/);
    expect(mock.countCalls('AUTHORIZATION')).toBe(1);
    expect((await statuses(reference)).slice(-4)).toEqual([
      NfeStatus.Sending,
      NfeStatus.CommunicationError,
      NfeStatus.PendingReconciliation,
      NfeStatus.Authorized,
    ]);
  });

  it('requisição que nunca chegou: consulta devolve 217 e o documento continua pendente', async () => {
    const { service, queued, mock } = setup();
    mock.scriptAuthorizations({ type: 'lose-request' });
    const reference = await queued();
    await service.transmit(reference);

    const reconciled = await service.reconcile(reference);
    expect(reconciled).toMatchObject({
      outcome: 'NOT_FOUND',
      resolved: false,
      invoice: { status: NfeStatus.PendingReconciliation, lastStatus: { statusCode: 217 } },
    });
    expect(mock.countCalls('AUTHORIZATION')).toBe(1);
  });

  it('consulta sem resposta mantém a pendência e pode ser repetida', async () => {
    const { service, queued, mock } = setup();
    mock
      .scriptAuthorizations({ type: 'lose-response-after-processing' })
      .scriptQueries({ type: 'lose-response' });
    const reference = await queued();
    await service.transmit(reference);

    expect(await service.reconcile(reference)).toMatchObject({ outcome: 'NO_RESPONSE', resolved: false });
    expect(await service.reconcile(reference)).toMatchObject({ outcome: 'AUTHORIZED', resolved: true });
  });

  it('lote em processamento (103) é resolvido por consulta', async () => {
    const { service, queued, mock } = setup();
    mock.scriptAuthorizations({ type: 'accept-for-processing' });
    const reference = await queued();

    expect((await service.transmit(reference)).invoice.status).toBe(NfeStatus.Processing);
    expect(await service.reconcile(reference)).toMatchObject({ outcome: 'AUTHORIZED', resolved: true });
  });

  it.each([
    ['duplicidade (204)', { kind: 'DUPLICATE', statusCode: 204, statusReason: 'Rejeição: Duplicidade de NF-e' }],
    ['código não reconhecido', { kind: 'UNRECOGNIZED', statusCode: 107, statusReason: 'Serviço em Operação' }],
  ] as const)('%s leva a reconciliação, nunca a reenvio', async (_label, result) => {
    const { service, queued } = setup({ sefaz: stubProvider(result) });
    const outcome = await service.transmit(await queued());
    expect(outcome.invoice.status).toBe(NfeStatus.PendingReconciliation);
  });

  it('protocolo de outra chave não é aceito como autorização', async () => {
    const result: AuthorizationResult = {
      kind: 'AUTHORIZED',
      protocol: {
        accessKey: '35260911222333000181550010000099991482139671',
        statusCode: 100,
        statusReason: 'Autorizado o uso da NF-e',
        protocolNumber: '135260000000001',
        receivedAt: new Date(),
      },
    };
    const { service, queued } = setup({ sefaz: stubProvider(result) });

    const outcome = await service.transmit(await queued());
    expect(outcome).toMatchObject({
      outcome: 'PROTOCOL_MISMATCH',
      invoice: { status: NfeStatus.PendingReconciliation },
    });
    expect(outcome.invoice.protocol).toBeUndefined();
  });

  it('erro inesperado do provider é tratado como desfecho desconhecido', async () => {
    const { service, queued } = setup({ sefaz: stubProvider(new Error('socket hang up')) });
    const outcome = await service.transmit(await queued());
    expect(outcome).toMatchObject({ outcome: 'NO_RESPONSE', invoice: { status: NfeStatus.PendingReconciliation } });
  });

  it('tentativa abandonada por queda do processo é recuperada como pendente', async () => {
    const { service, queued, store } = setup();
    const reference = await queued();
    await store.beginAttempt({
      ...reference,
      operation: 'AUTHORIZATION',
      path: [NfeStatus.Queued, NfeStatus.Sending],
    });

    expect(
      await service.recoverAbandonedAttempts({ tenantId: scope.tenantId, startedBefore: new Date(Date.now() - 60_000) }),
    ).toEqual([]);
    const recovered = await service.recoverAbandonedAttempts({
      tenantId: scope.tenantId,
      startedBefore: new Date(Date.now() + 60_000),
    });

    expect(recovered.map((invoice) => invoice.status)).toEqual([NfeStatus.PendingReconciliation]);
    expect((await service.reconcile(reference)).outcome).toBe('NOT_FOUND');
  });
});

describe('concorrência e ambiente', () => {
  it('duas transmissões simultâneas do mesmo documento geram uma única chamada à SEFAZ', async () => {
    const { service, queued, mock } = setup();
    const reference = await queued();

    const results = await Promise.allSettled([service.transmit(reference), service.transmit(reference)]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(mock.countCalls('AUTHORIZATION')).toBe(1);
  });

  it('SEFAZ simulada recusa produção sem chamar nada, e o documento volta à fila', async () => {
    const { service, queued, mock, store } = setup();
    const reference = await queued(withIdentification(makeDraft(), { environment: Environment.Production }));

    await expect(service.transmit(reference)).rejects.toBeInstanceOf(ProviderConfigurationError);
    expect(mock.calls).toHaveLength(0);
    expect((await store.findInvoice(reference.tenantId, reference.invoiceId))?.status).toBe(NfeStatus.Queued);
  });
});
