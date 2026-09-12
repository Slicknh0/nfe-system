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
  type ReconciliationOutcome,
  type RecoveryInput,
  type ReviseDraftInput,
  type SefazInteractionOutcome,
} from './emission-service.js';

export {
  ConcurrentModificationError,
  IdempotencyConflictError,
  InvalidIdempotencyKeyError,
  InvoiceNotFoundError,
  NumberedInvoiceChangeError,
  OperationNotAllowedError,
  SeriesExhaustedError,
  SigningRefusedError,
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
  Clock,
  DraftCreation,
  DraftDocument,
  DraftIdentification,
  DraftRevision,
  EmissionStore,
  InvoiceRecord,
  IssuanceAssignedField,
  NewDraft,
  SchemaProblem,
  SchemaValidator,
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
