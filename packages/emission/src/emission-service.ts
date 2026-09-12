/**
 * Serviço de emissão: rascunho → número → XML assinado → SEFAZ → desfecho.
 *
 * Três regras sustentam o desenho, todas verificadas por teste:
 *
 * 1. **Número só é consumido com XML válido.** Montagem, assinatura e XSD
 *    acontecem com a sequência da série travada. Qualquer falha desfaz a
 *    transação e o número volta a estar disponível.
 *
 * 2. **Desfecho desconhecido nunca é retransmitido.** Timeout, resposta
 *    ininteligível ou duplicidade levam a `PENDING_RECONCILIATION`, que só sai
 *    por consulta. O MOC 7.0, Anexo III, item 2.3.3, descreve essas "NF-e
 *    Pendentes de Retorno": podem não ter chegado, estar na fila ou já ter sido
 *    autorizadas.
 *
 * 3. **A tentativa é registrada antes da chamada.** Se o processo cair com a
 *    requisição em voo, a tentativa aberta é encontrada pela recuperação e
 *    tratada como desfecho desconhecido.
 */

import { randomInt } from 'node:crypto';
import {
  NfeStatus,
  buildUnsignedNfe,
  isEditable,
  isFiscalError,
  isResolved,
  isTechnicalError,
  type UnsignedNfe,
} from '@nfe/core';
import {
  ProviderConfigurationError,
  type AuthorizationResult,
  type InvoiceProtocol,
  type ProtocolQueryResult,
  type SefazProvider,
  type StatusReply,
} from '@nfe/sefaz';
import { completeDraft, draftRequestHash, pathToDraft } from './draft.js';
import {
  ConcurrentModificationError,
  InvalidIdempotencyKeyError,
  InvoiceNotFoundError,
  OperationNotAllowedError,
  SigningRefusedError,
} from './errors.js';
import type {
  AttemptOutcome,
  Clock,
  DraftCreation,
  DraftDocument,
  EmissionStore,
  InvoiceRecord,
  SchemaValidator,
  SignedArtifact,
  SigningContext,
  XmlSigner,
} from './ports.js';

const IDEMPOTENCY_KEY = /^[\x21-\x7E]{1,255}$/;
const MAX_REASON_LENGTH = 4000;

const REQUEUE_PATH: readonly NfeStatus[] = [NfeStatus.Sending, NfeStatus.Queued];
const UNKNOWN_OUTCOME_PATH: readonly NfeStatus[] = [
  NfeStatus.Sending,
  NfeStatus.CommunicationError,
  NfeStatus.PendingReconciliation,
];

export interface EmissionServiceDependencies {
  readonly store: EmissionStore;
  readonly sefaz: SefazProvider;
  readonly signer: XmlSigner;
  readonly schemaValidator: SchemaValidator;
  readonly clock?: Clock;
  /** `cNF` com 8 dígitos. Padrão: aleatório criptográfico. */
  readonly randomCode?: () => string;
}

export interface InvoiceReference {
  readonly tenantId: string;
  readonly invoiceId: string;
}

export interface CreateDraftInput {
  readonly tenantId: string;
  readonly issuerId: string;
  readonly idempotencyKey: string;
  readonly draft: DraftDocument;
}

export interface ReviseDraftInput extends InvoiceReference {
  readonly expectedVersion: number;
  readonly draft: DraftDocument;
}

export type IssueOutcome =
  | { readonly kind: 'QUEUED'; readonly invoice: InvoiceRecord }
  | {
      readonly kind: 'LOCAL_VALIDATION_ERROR';
      readonly invoice: InvoiceRecord;
      readonly problems: readonly string[];
    };

export interface SefazInteractionOutcome {
  readonly outcome: AttemptOutcome;
  readonly invoice: InvoiceRecord;
}

export interface ReconciliationOutcome extends SefazInteractionOutcome {
  /** `true` quando o documento chegou a um desfecho conhecido. */
  readonly resolved: boolean;
}

export interface RecoveryInput {
  readonly tenantId: string;
  readonly startedBefore: Date;
}

class LocalValidationFailure extends Error {
  constructor(readonly problems: readonly string[]) {
    super(problems.join('\n'));
    this.name = 'LocalValidationFailure';
  }
}

interface Completion {
  readonly path: readonly NfeStatus[];
  readonly outcome: AttemptOutcome;
  readonly lastStatus?: StatusReply;
  readonly protocol?: InvoiceProtocol;
}

export class EmissionService {
  private readonly store: EmissionStore;
  private readonly sefaz: SefazProvider;
  private readonly signer: XmlSigner;
  private readonly schemaValidator: SchemaValidator;
  private readonly clock: Clock;
  private readonly randomCode: () => string;

  constructor(dependencies: EmissionServiceDependencies) {
    this.store = dependencies.store;
    this.sefaz = dependencies.sefaz;
    this.signer = dependencies.signer;
    this.schemaValidator = dependencies.schemaValidator;
    this.clock = dependencies.clock ?? { now: () => new Date() };
    this.randomCode =
      dependencies.randomCode ?? (() => String(randomInt(0, 100_000_000)).padStart(8, '0'));
  }

  async createDraft(input: CreateDraftInput): Promise<DraftCreation> {
    if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
      throw new InvalidIdempotencyKeyError();
    }
    return await this.store.createDraft({
      tenantId: input.tenantId,
      issuerId: input.issuerId,
      idempotencyKey: input.idempotencyKey,
      requestHash: draftRequestHash(input.issuerId, input.draft),
      draft: input.draft,
    });
  }

  async reviseDraft(input: ReviseDraftInput): Promise<InvoiceRecord> {
    const current = await this.require(input);
    if (!isEditable(current.status)) {
      throw new OperationNotAllowedError('revisar', current.status);
    }
    return await this.store.reviseDraft({
      tenantId: input.tenantId,
      invoiceId: input.invoiceId,
      path: pathToDraft(current.status),
      expectedVersion: input.expectedVersion,
      draft: input.draft,
    });
  }

  async issue(reference: InvoiceReference): Promise<IssueOutcome> {
    const current = await this.require(reference);
    if (!isEditable(current.status)) {
      throw new OperationNotAllowedError('emitir', current.status);
    }
    const { tenantId, invoiceId } = reference;
    const toDraft = pathToDraft(current.status);

    try {
      const invoice = await this.store.signWithNumber(
        {
          tenantId,
          invoiceId,
          path: [
            ...toDraft,
            NfeStatus.Validating,
            NfeStatus.Validated,
            NfeStatus.Signed,
            NfeStatus.Queued,
          ],
        },
        (context) => this.buildSignedInvoice(context),
      );
      return { kind: 'QUEUED', invoice };
    } catch (error) {
      if (!(error instanceof LocalValidationFailure)) {
        throw error;
      }
      const invoice = await this.store.transition({
        tenantId,
        invoiceId,
        path: [...toDraft, NfeStatus.Validating, NfeStatus.LocalValidationError],
        reason: truncate(error.problems.join('\n')),
      });
      return { kind: 'LOCAL_VALIDATION_ERROR', invoice, problems: error.problems };
    }
  }

  async transmit(reference: InvoiceReference): Promise<SefazInteractionOutcome> {
    const current = await this.require(reference);
    if (current.status !== NfeStatus.Queued) {
      throw new OperationNotAllowedError('transmitir', current.status);
    }
    const { tenantId, invoiceId } = reference;
    const { invoice, attemptId } = await this.store.beginAttempt({
      tenantId,
      invoiceId,
      operation: 'AUTHORIZATION',
      path: [NfeStatus.Queued, NfeStatus.Sending],
    });
    const { accessKey, signedXml } = signedContent(invoice);

    let completion: Completion;
    try {
      const result = await this.sefaz.authorize({
        environment: invoice.environment,
        accessKey,
        signedXml,
      });
      completion = authorizationCompletion(result, accessKey);
    } catch (error) {
      const outcome = isKnownNotSent(error) ? 'NOT_SENT' : 'NO_RESPONSE';
      const finished = await this.store.finishAttempt({
        tenantId,
        invoiceId,
        attemptId,
        path: outcome === 'NOT_SENT' ? REQUEUE_PATH : UNKNOWN_OUTCOME_PATH,
        outcome,
        reason: describeError(error),
      });
      if (error instanceof ProviderConfigurationError) {
        throw error;
      }
      return { outcome, invoice: finished };
    }

    const finished = await this.store.finishAttempt({
      tenantId,
      invoiceId,
      attemptId,
      ...completion,
    });
    return { outcome: completion.outcome, invoice: finished };
  }

  async reconcile(reference: InvoiceReference): Promise<ReconciliationOutcome> {
    const current = await this.require(reference);
    if (
      current.status !== NfeStatus.PendingReconciliation &&
      current.status !== NfeStatus.Processing
    ) {
      throw new OperationNotAllowedError('reconciliar', current.status);
    }
    const { tenantId, invoiceId } = reference;
    const status = current.status;
    const { invoice, attemptId } = await this.store.beginAttempt({
      tenantId,
      invoiceId,
      operation: 'PROTOCOL_QUERY',
      path: [status],
    });
    const { accessKey } = signedContent(invoice);

    let completion: Completion;
    try {
      const result = await this.sefaz.queryProtocol({ environment: invoice.environment, accessKey });
      completion = queryCompletion(result, status, accessKey);
    } catch (error) {
      const outcome = isKnownNotSent(error) ? 'NOT_SENT' : 'NO_RESPONSE';
      const finished = await this.store.finishAttempt({
        tenantId,
        invoiceId,
        attemptId,
        path: [status],
        outcome,
        reason: describeError(error),
      });
      if (error instanceof ProviderConfigurationError) {
        throw error;
      }
      return { outcome, invoice: finished, resolved: false };
    }

    const finished = await this.store.finishAttempt({
      tenantId,
      invoiceId,
      attemptId,
      ...completion,
    });
    return {
      outcome: completion.outcome,
      invoice: finished,
      resolved: isResolved(finished.status),
    };
  }

  /**
   * Fecha tentativas que ficaram abertas — o processo caiu com a requisição em
   * voo. Envio abandonado vira desfecho desconhecido; consulta abandonada não
   * muda o estado.
   */
  async recoverAbandonedAttempts(input: RecoveryInput): Promise<readonly InvoiceRecord[]> {
    const recovered: InvoiceRecord[] = [];
    for (const attempt of await this.store.findUnfinishedAttempts(input)) {
      const invoice = await this.store.findInvoice(input.tenantId, attempt.invoiceId);
      if (invoice === undefined) {
        continue;
      }
      try {
        recovered.push(
          await this.store.finishAttempt({
            tenantId: input.tenantId,
            invoiceId: attempt.invoiceId,
            attemptId: attempt.attemptId,
            path: attempt.operation === 'AUTHORIZATION' ? UNKNOWN_OUTCOME_PATH : [invoice.status],
            outcome: 'ABANDONED',
            reason: 'Tentativa sem conclusão registrada; o desfecho é tratado como desconhecido.',
          }),
        );
      } catch (error) {
        // A tentativa foi concluída entre a listagem e a recuperação.
        if (!(error instanceof ConcurrentModificationError)) {
          throw error;
        }
      }
    }
    return recovered;
  }

  private async require(reference: InvoiceReference): Promise<InvoiceRecord> {
    const invoice = await this.store.findInvoice(reference.tenantId, reference.invoiceId);
    if (invoice === undefined) {
      throw new InvoiceNotFoundError(reference.invoiceId);
    }
    return invoice;
  }

  private async buildSignedInvoice({ invoice, number }: SigningContext): Promise<SignedArtifact> {
    const now = this.clock.now();

    let unsigned: UnsignedNfe;
    try {
      unsigned = buildUnsignedNfe(
        completeDraft(invoice.draft, { number, randomCode: this.randomCode(), issuedAt: now }),
      );
    } catch (error) {
      if (isFiscalError(error)) {
        throw new LocalValidationFailure([error.message]);
      }
      throw error;
    }

    let signedXml: string;
    try {
      signedXml = await this.signer.sign({
        tenantId: invoice.tenantId,
        issuerId: invoice.issuerId,
        unsignedXml: unsigned.xml,
        now,
      });
    } catch (error) {
      if (error instanceof SigningRefusedError) {
        throw new LocalValidationFailure([error.message]);
      }
      throw error;
    }

    const validation = this.schemaValidator.validate(signedXml);
    if (!validation.valid) {
      throw new LocalValidationFailure(
        validation.errors.map((problem) => `${problem.explanation} [${problem.technicalMessage}]`),
      );
    }
    return { accessKey: unsigned.accessKey, signedXml };
  }
}

function signedContent(invoice: InvoiceRecord): { accessKey: string; signedXml: string } {
  if (invoice.accessKey === undefined || invoice.signedXml === undefined) {
    throw new Error(`Documento ${invoice.id} em ${invoice.status} sem XML assinado.`);
  }
  return { accessKey: invoice.accessKey, signedXml: invoice.signedXml };
}

function statusOf(reply: StatusReply): StatusReply {
  return { statusCode: reply.statusCode, statusReason: reply.statusReason };
}

function authorizationCompletion(result: AuthorizationResult, accessKey: string): Completion {
  switch (result.kind) {
    case 'AUTHORIZED':
    case 'DENIED':
      if (result.protocol.accessKey !== accessKey) {
        return {
          path: UNKNOWN_OUTCOME_PATH,
          outcome: 'PROTOCOL_MISMATCH',
          lastStatus: statusOf(result.protocol),
        };
      }
      return {
        path: [
          NfeStatus.Sending,
          result.kind === 'AUTHORIZED' ? NfeStatus.Authorized : NfeStatus.Denied,
        ],
        outcome: result.kind,
        lastStatus: statusOf(result.protocol),
        protocol: result.protocol,
      };
    case 'REJECTED':
      return {
        path: [NfeStatus.Sending, NfeStatus.Rejected],
        outcome: 'REJECTED',
        lastStatus: statusOf(result),
      };
    case 'IN_PROCESSING':
      return {
        path: [NfeStatus.Sending, NfeStatus.Processing],
        outcome: 'IN_PROCESSING',
        lastStatus: statusOf(result),
      };
    case 'SERVICE_UNAVAILABLE':
      return { path: REQUEUE_PATH, outcome: 'SERVICE_UNAVAILABLE', lastStatus: statusOf(result) };
    // Duplicidade: um envio anterior desta numeração pode ter sido autorizado.
    case 'DUPLICATE':
    case 'UNRECOGNIZED':
      return { path: UNKNOWN_OUTCOME_PATH, outcome: result.kind, lastStatus: statusOf(result) };
  }
}

function queryCompletion(
  result: ProtocolQueryResult,
  status: NfeStatus,
  accessKey: string,
): Completion {
  switch (result.kind) {
    case 'AUTHORIZED':
    case 'DENIED':
      if (result.protocol.accessKey !== accessKey) {
        return { path: [status], outcome: 'PROTOCOL_MISMATCH', lastStatus: statusOf(result.protocol) };
      }
      return {
        path: [status, result.kind === 'AUTHORIZED' ? NfeStatus.Authorized : NfeStatus.Denied],
        outcome: result.kind,
        lastStatus: statusOf(result.protocol),
        protocol: result.protocol,
      };
    // Nenhum destes resolve o documento. `NOT_FOUND` em particular não prova
    // que a NF-e não esteja na fila da SEFAZ (MOC 7.0, Anexo III, 2.3.3).
    case 'NOT_FOUND':
    case 'CANCELLED':
    case 'SERVICE_UNAVAILABLE':
    case 'QUERY_REJECTED':
    case 'UNRECOGNIZED':
      return { path: [status], outcome: result.kind, lastStatus: statusOf(result) };
  }
}

/** Só é "não enviado" o que o transporte garante que não saiu. Na dúvida, saiu. */
function isKnownNotSent(error: unknown): boolean {
  return (
    error instanceof ProviderConfigurationError ||
    (isTechnicalError(error) && !error.outcomeUnknown)
  );
}

function describeError(error: unknown): string {
  return truncate(error instanceof Error ? `${error.name}: ${error.message}` : 'Falha sem detalhe.');
}

function truncate(text: string): string {
  return text.length > MAX_REASON_LENGTH ? `${text.slice(0, MAX_REASON_LENGTH)}…` : text;
}
