/**
 * Serviço de emissão: rascunho → número → XML assinado → SEFAZ → desfecho.
 *
 * Regras que sustentam o desenho, todas verificadas por teste:
 *
 * 1. **Número só é consumido com XML válido.** Montagem, assinatura e XSD
 *    acontecem com a sequência da série travada. Qualquer falha desfaz a
 *    transação e o número volta a estar disponível.
 *
 * 2. **Desfecho desconhecido nunca é retransmitido.** Timeout, resposta
 *    ininteligível ou duplicidade levam a `PENDING_RECONCILIATION`, que só sai
 *    por consulta — ou pela inutilização do número. O MOC 7.0, Anexo III, item
 *    2.3.3, descreve essas "NF-e Pendentes de Retorno": podem não ter chegado,
 *    estar na fila ou já ter sido autorizadas; as não autorizadas nem denegadas
 *    têm a numeração inutilizada.
 *
 * 3. **A tentativa é registrada antes da chamada.** Se o processo cair com a
 *    requisição em voo, a tentativa aberta é encontrada pela recuperação e
 *    tratada como desfecho desconhecido.
 *
 * 4. **A SEFAZ arbitra a inutilização.** Se a nota pendente tiver sido
 *    processada, a inutilização é recusada (241) e o documento continua
 *    pendente até a consulta decidir. Repetir um pedido sem resposta é seguro:
 *    a SEFAZ devolve o protocolo do pedido idêntico já homologado (563).
 */

import { randomInt } from 'node:crypto';
import {
  NfeStatus,
  buildUnsignedInutilization,
  buildUnsignedNfe,
  isEditable,
  isFiscalError,
  isResolved,
  isTechnicalError,
  parseAccessKey,
  type UnsignedNfe,
} from '@nfe/core';
import {
  ProviderConfigurationError,
  type AuthorizationResult,
  type InvoiceProtocol,
  type NumberVoidResult,
  type ProtocolQueryResult,
  type SefazProvider,
  type StatusReply,
} from '@nfe/sefaz';
import { completeDraft, draftRequestHash, pathToDraft } from './draft.js';
import {
  ConcurrentModificationError,
  InvalidIdempotencyKeyError,
  InvalidVoidRequestError,
  InvoiceNotFoundError,
  OperationNotAllowedError,
  SigningRefusedError,
  VoidNotYetAllowedError,
} from './errors.js';
import type {
  AttemptOutcome,
  Clock,
  DraftCreation,
  DraftDocument,
  EmissionStore,
  InvoiceRecord,
  NumberVoidUpdate,
  SchemaValidator,
  SignedArtifact,
  SigningContext,
  XmlSigner,
} from './ports.js';
import {
  DEFAULT_RECONCILIATION_POLICY,
  planReconciliation,
  type ReconciliationPlan,
  type ReconciliationPolicy,
} from './reconciliation-policy.js';

const IDEMPOTENCY_KEY = /^[\x21-\x7E]{1,255}$/;
const MAX_REASON_LENGTH = 4000;
const DEFAULT_CYCLE_LIMIT = 50;

const REQUEUE_PATH: readonly NfeStatus[] = [NfeStatus.Sending, NfeStatus.Queued];
const UNKNOWN_OUTCOME_PATH: readonly NfeStatus[] = [
  NfeStatus.Sending,
  NfeStatus.CommunicationError,
  NfeStatus.PendingReconciliation,
];

/** Estados em que o número já atribuído pode ser inutilizado. */
const VOIDABLE = new Set<NfeStatus>([
  NfeStatus.PendingReconciliation,
  NfeStatus.Rejected,
  NfeStatus.LocalValidationError,
  NfeStatus.Draft,
]);

export interface EmissionServiceDependencies {
  readonly store: EmissionStore;
  readonly sefaz: SefazProvider;
  readonly signer: XmlSigner;
  readonly schemaValidator: SchemaValidator;
  readonly clock?: Clock;
  /** `cNF` com 8 dígitos. Padrão: aleatório criptográfico. */
  readonly randomCode?: () => string;
  readonly reconciliationPolicy?: ReconciliationPolicy;
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

export interface VoidNumberInput extends InvoiceReference {
  /** `xJust`: 15 a 255 caracteres. */
  readonly justification: string;
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

export interface VoidOutcome extends SefazInteractionOutcome {
  /** `true` quando a numeração ficou inutilizada. */
  readonly voided: boolean;
}

export interface RecoveryInput {
  readonly tenantId: string;
  readonly startedBefore: Date;
}

export interface ReconciliationCycleInput {
  readonly tenantId: string;
  readonly limit?: number;
}

export interface ReconciliationCycleReport {
  /** Consultas feitas neste ciclo. */
  readonly queried: readonly ReconciliationOutcome[];
  /** Documentos cuja próxima consulta ainda não chegou. */
  readonly waiting: number;
  /**
   * Documentos com a inutilização liberada pela política. A inutilização é ato
   * fiscal e não é disparada pelo ciclo: exige chamada explícita a `voidNumber`.
   */
  readonly voidAllowed: readonly string[];
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
  readonly numberVoid?: NumberVoidUpdate;
}

export class EmissionService {
  private readonly store: EmissionStore;
  private readonly sefaz: SefazProvider;
  private readonly signer: XmlSigner;
  private readonly schemaValidator: SchemaValidator;
  private readonly clock: Clock;
  private readonly randomCode: () => string;
  private readonly policy: ReconciliationPolicy;

  constructor(dependencies: EmissionServiceDependencies) {
    this.store = dependencies.store;
    this.sefaz = dependencies.sefaz;
    this.signer = dependencies.signer;
    this.schemaValidator = dependencies.schemaValidator;
    this.clock = dependencies.clock ?? { now: () => new Date() };
    this.randomCode =
      dependencies.randomCode ?? (() => String(randomInt(0, 100_000_000)).padStart(8, '0'));
    this.policy = dependencies.reconciliationPolicy ?? DEFAULT_RECONCILIATION_POLICY;
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

  /** Plano de reconciliação do documento no instante atual, segundo a política. */
  async planFor(reference: InvoiceReference): Promise<ReconciliationPlan> {
    const invoice = await this.require(reference);
    const attempts = await this.store.findAttempts(reference.tenantId, reference.invoiceId);
    return planReconciliation(invoice, attempts, this.clock.now(), this.policy);
  }

  /**
   * Consulta as notas pendentes cuja vez chegou. Não retransmite e não
   * inutiliza nada: apenas descobre desfechos e aponta o que a política libera.
   */
  async runReconciliationCycle(input: ReconciliationCycleInput): Promise<ReconciliationCycleReport> {
    const invoices = await this.store.listInvoices({
      tenantId: input.tenantId,
      statuses: [NfeStatus.PendingReconciliation, NfeStatus.Processing],
      limit: input.limit ?? DEFAULT_CYCLE_LIMIT,
    });

    const queried: ReconciliationOutcome[] = [];
    const voidAllowed: string[] = [];
    let waiting = 0;

    for (const invoice of invoices) {
      const attempts = await this.store.findAttempts(input.tenantId, invoice.id);
      const plan = planReconciliation(invoice, attempts, this.clock.now(), this.policy);
      switch (plan.action) {
        case 'QUERY_NOW':
          try {
            queried.push(await this.reconcile({ tenantId: input.tenantId, invoiceId: invoice.id }));
          } catch (error) {
            // Outra operação resolveu o documento entre a listagem e a consulta.
            if (
              !(error instanceof ConcurrentModificationError) &&
              !(error instanceof OperationNotAllowedError)
            ) {
              throw error;
            }
          }
          break;
        case 'WAIT':
          waiting += 1;
          break;
        case 'VOID_ALLOWED':
          voidAllowed.push(invoice.id);
          break;
        case 'NOT_APPLICABLE':
          break;
      }
    }

    return { queried, waiting, voidAllowed };
  }

  /**
   * Inutiliza o número do documento na SEFAZ.
   *
   * Nota pendente de retorno só é inutilizada quando a política libera. Nota
   * rejeitada, ou reaberta depois de numerada, pode ser inutilizada a qualquer
   * momento — a rejeição é desfecho conhecido.
   *
   * Pedido inválido (justificativa, certificado, schema) é recusado antes de
   * qualquer gravação ou chamada.
   */
  async voidNumber(input: VoidNumberInput): Promise<VoidOutcome> {
    const current = await this.require(input);
    if (!VOIDABLE.has(current.status) || current.accessKey === undefined || current.number === undefined) {
      throw new OperationNotAllowedError('inutilizar a numeração de', current.status);
    }
    const { tenantId, invoiceId } = input;
    const now = this.clock.now();

    if (current.status === NfeStatus.PendingReconciliation) {
      const attempts = await this.store.findAttempts(tenantId, invoiceId);
      const plan = planReconciliation(current, attempts, now, this.policy);
      if (plan.action !== 'VOID_ALLOWED') {
        throw new VoidNotYetAllowedError(invoiceId, describePlan(plan));
      }
    }

    // Campos da própria chave: a inutilização recai exatamente sobre o número
    // que foi (ou pode ter sido) transmitido.
    const key = parseAccessKey(current.accessKey);
    const request = {
      environment: current.environment,
      stateCode: key.cUF,
      year: key.year,
      cnpj: key.cnpj,
      series: key.series,
      firstNumber: key.number,
      lastNumber: key.number,
      justification: input.justification,
    };
    const unsigned = buildUnsignedInutilization(request, { now });
    const signedXml = await this.signer.sign({
      tenantId,
      issuerId: current.issuerId,
      document: 'INUTILIZATION',
      unsignedXml: unsigned.xml,
      now,
    });
    const validation = this.schemaValidator.validate(signedXml, 'INUTILIZATION');
    if (!validation.valid) {
      throw new InvalidVoidRequestError(
        validation.errors.map((problem) => `${problem.explanation} [${problem.technicalMessage}]`),
      );
    }

    const status = current.status;
    const { invoice, attemptId } = await this.store.beginAttempt({
      tenantId,
      invoiceId,
      operation: 'NUMBER_VOID',
      path: [status],
      numberVoid: {
        year: request.year,
        justification: input.justification.trim(),
        requestId: unsigned.id,
        signedXml,
      },
    });

    let completion: Completion;
    try {
      const result = await this.sefaz.voidNumbers({
        environment: invoice.environment,
        cnpj: request.cnpj,
        series: request.series,
        firstNumber: request.firstNumber,
        lastNumber: request.lastNumber,
        signedXml,
      });
      completion = voidCompletion(result, status);
    } catch (error) {
      const outcome = isKnownNotSent(error) ? 'NOT_SENT' : 'NO_RESPONSE';
      const finished = await this.store.finishAttempt({
        tenantId,
        invoiceId,
        attemptId,
        path: [status],
        outcome,
        reason: describeError(error),
        numberVoid: { status: 'REQUESTED' },
      });
      if (error instanceof ProviderConfigurationError) {
        throw error;
      }
      return { outcome, invoice: finished, voided: false };
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
      voided: finished.status === NfeStatus.NumberVoided,
    };
  }

  /**
   * Fecha tentativas que ficaram abertas — o processo caiu com a requisição em
   * voo. Envio abandonado vira desfecho desconhecido; consulta e inutilização
   * abandonadas não mudam o estado (a inutilização pode ser repetida).
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
            ...(attempt.operation === 'NUMBER_VOID'
              ? { numberVoid: { status: 'REQUESTED' as const } }
              : {}),
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
        document: 'NFE',
        unsignedXml: unsigned.xml,
        now,
      });
    } catch (error) {
      if (error instanceof SigningRefusedError) {
        throw new LocalValidationFailure([error.message]);
      }
      throw error;
    }

    const validation = this.schemaValidator.validate(signedXml, 'NFE');
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

function voidCompletion(result: NumberVoidResult, status: NfeStatus): Completion {
  switch (result.kind) {
    case 'VOIDED':
      return {
        path: [status, NfeStatus.NumberVoided],
        outcome: 'VOIDED',
        lastStatus: statusOf(result.protocol),
        numberVoid: { status: 'VOIDED', protocol: result.protocol },
      };
    // O pedido cobre um único número; "uma NF-e da faixa já está inutilizada"
    // só pode ser este número. Não há protocolo novo para registrar.
    case 'RANGE_ALREADY_VOIDED':
      return {
        path: [status, NfeStatus.NumberVoided],
        outcome: 'RANGE_ALREADY_VOIDED',
        lastStatus: statusOf(result),
        numberVoid: { status: 'VOIDED' },
      };
    // A nota foi processada pela SEFAZ: a consulta decide o documento.
    case 'NUMBER_ALREADY_USED':
      return {
        path: [status],
        outcome: 'NUMBER_ALREADY_USED',
        lastStatus: statusOf(result),
        numberVoid: { status: 'REJECTED' },
      };
    case 'REJECTED':
      return {
        path: [status],
        outcome: 'REJECTED',
        lastStatus: statusOf(result),
        numberVoid: { status: 'REJECTED' },
      };
    case 'SERVICE_UNAVAILABLE':
    case 'UNRECOGNIZED':
      return {
        path: [status],
        outcome: result.kind,
        lastStatus: statusOf(result),
        numberVoid: { status: 'REQUESTED' },
      };
  }
}

function describePlan(plan: ReconciliationPlan): string {
  switch (plan.action) {
    case 'WAIT':
      return `a próxima consulta está prevista para ${plan.notBefore.toISOString()}.`;
    case 'QUERY_NOW':
      return 'a nota ainda precisa ser consultada.';
    case 'NOT_APPLICABLE':
      return 'o documento não está pendente de retorno.';
    case 'VOID_ALLOWED':
      return 'liberada.';
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
