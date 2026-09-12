/**
 * `@nfe/emission` — casos de uso de emissão e as portas que eles exigem.
 *
 * Não conhece banco, SOAP nem biblioteca de assinatura: recebe tudo por
 * injeção. A composição concreta acontece na aplicação.
 */

export {
  EmissionService,
  type CreateDraftInput,
  type EmissionServiceDependencies,
  type InvoiceReference,
  type IssueOutcome,
  type ReconciliationCycleInput,
  type ReconciliationCycleReport,
  type ReconciliationOutcome,
  type RecoveryInput,
  type ReviseDraftInput,
  type SefazInteractionOutcome,
  type VoidNumberInput,
  type VoidOutcome,
} from './emission-service.js';

export {
  DEFAULT_RECONCILIATION_POLICY,
  planReconciliation,
  type ReconciliationPlan,
  type ReconciliationPolicy,
} from './reconciliation-policy.js';

export {
  ConcurrentModificationError,
  IdempotencyConflictError,
  InvalidIdempotencyKeyError,
  InvalidVoidRequestError,
  InvoiceNotFoundError,
  NumberedInvoiceChangeError,
  OperationNotAllowedError,
  SeriesExhaustedError,
  SigningRefusedError,
  VoidNotYetAllowedError,
} from './errors.js';

export {
  assertStatusPath,
  canonicalJson,
  completeDraft,
  decodeDocument,
  draftRequestHash,
  encodeDocument,
  pathToDraft,
  type EncodedValue,
  type IssuanceAssignment,
} from './draft.js';

export type {
  AttemptCompletion,
  AttemptOutcome,
  AttemptRequest,
  AttemptStart,
  AttemptSummary,
  Clock,
  DraftCreation,
  DraftDocument,
  DraftIdentification,
  DraftRevision,
  EmissionStore,
  InvoiceListQuery,
  InvoiceRecord,
  IssuanceAssignedField,
  NewDraft,
  NumberVoidDraft,
  NumberVoidRecord,
  NumberVoidStatus,
  NumberVoidUpdate,
  SchemaProblem,
  SchemaValidator,
  SignableDocument,
  SignedArtifact,
  SigningContext,
  SigningRequest,
  StatusHistoryEntry,
  TransitionRequest,
  UnfinishedAttempt,
  UnfinishedAttemptQuery,
  XmlSigner,
} from './ports.js';

/** Limite de `nNF` (tipo `TNF`: até 9 dígitos, sem zero à esquerda). */
export const MAX_INVOICE_NUMBER = 999_999_999;
