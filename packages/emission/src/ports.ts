/**
 * Portas da camada de aplicação.
 *
 * O serviço de emissão depende destas interfaces, e não de Postgres, SOAP ou
 * biblioteca de assinatura. Cada adaptador concreto precisa passar na mesma
 * suíte de contrato (`tests/support/emission-store-contract.ts`), o que impede
 * o fake de teste de ser mais permissivo que o banco.
 */

import type { Identification, NfeDocument, NfeStatus } from '@nfe/core';
import type {
  EnvironmentCode,
  InvoiceProtocol,
  SefazOperation,
  StatusReply,
} from '@nfe/sefaz';

/** Campos atribuídos no momento da emissão, nunca informados pelo usuário. */
export type IssuanceAssignedField = 'number' | 'randomCode' | 'issuedAt';

export type DraftIdentification = Omit<Identification, IssuanceAssignedField>;

export interface DraftDocument extends Omit<NfeDocument, 'identification'> {
  readonly identification: DraftIdentification;
}

export interface InvoiceRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly issuerId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly environment: EnvironmentCode;
  readonly series: number;
  readonly status: NfeStatus;
  /** Incrementada a cada alteração — base do controle otimista. */
  readonly version: number;
  readonly draft: DraftDocument;
  /** `nNF`. Uma vez atribuído, nunca muda. */
  readonly number?: number;
  readonly accessKey?: string;
  readonly signedXml?: string;
  readonly protocol?: InvoiceProtocol;
  readonly lastStatus?: StatusReply;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface StatusHistoryEntry {
  readonly from?: NfeStatus;
  readonly to: NfeStatus;
  readonly reason?: string;
  readonly occurredAt: Date;
}

export interface NewDraft {
  readonly tenantId: string;
  readonly issuerId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly draft: DraftDocument;
}

export interface DraftCreation {
  readonly invoice: InvoiceRecord;
  /** `false` quando a chave de idempotência já existia com o mesmo conteúdo. */
  readonly created: boolean;
}

/**
 * Caminho de estados a aplicar. `path[0]` é o estado atual esperado; os demais
 * são os saltos, cada um validado pela máquina de estados. Caminho de um único
 * elemento apenas confirma o estado, sob trava.
 */
export interface TransitionRequest {
  readonly tenantId: string;
  readonly invoiceId: string;
  readonly path: readonly NfeStatus[];
  readonly reason?: string;
  readonly lastStatus?: StatusReply;
}

export interface DraftRevision extends TransitionRequest {
  readonly expectedVersion: number;
  readonly draft: DraftDocument;
}

export interface SigningContext {
  readonly invoice: InvoiceRecord;
  /** Número a usar: o já atribuído ao documento ou o próximo da série. */
  readonly number: number;
}

export interface SignedArtifact {
  readonly accessKey: string;
  readonly signedXml: string;
}

export type AttemptOutcome =
  | 'AUTHORIZED'
  | 'DENIED'
  | 'REJECTED'
  | 'DUPLICATE'
  | 'IN_PROCESSING'
  | 'SERVICE_UNAVAILABLE'
  | 'UNRECOGNIZED'
  | 'CANCELLED'
  | 'NOT_FOUND'
  | 'QUERY_REJECTED'
  | 'PROTOCOL_MISMATCH'
  | 'NOT_SENT'
  | 'NO_RESPONSE'
  | 'ABANDONED';

export interface AttemptRequest extends TransitionRequest {
  readonly operation: SefazOperation;
}

export interface AttemptStart {
  readonly invoice: InvoiceRecord;
  readonly attemptId: string;
}

export interface AttemptCompletion extends TransitionRequest {
  readonly attemptId: string;
  readonly outcome: AttemptOutcome;
  readonly protocol?: InvoiceProtocol;
}

export interface UnfinishedAttempt {
  readonly attemptId: string;
  readonly invoiceId: string;
  readonly operation: SefazOperation;
  readonly startedAt: Date;
}

export interface UnfinishedAttemptQuery {
  readonly tenantId: string;
  readonly startedBefore: Date;
}

export interface EmissionStore {
  /** Idempotente por `(tenantId, idempotencyKey)`. Conteúdo diferente com a mesma chave é conflito. */
  createDraft(input: NewDraft): Promise<DraftCreation>;

  findInvoice(tenantId: string, invoiceId: string): Promise<InvoiceRecord | undefined>;

  findHistory(tenantId: string, invoiceId: string): Promise<readonly StatusHistoryEntry[]>;

  /** Substitui o conteúdo do rascunho. Série e ambiente não mudam depois de numerado. */
  reviseDraft(input: DraftRevision): Promise<InvoiceRecord>;

  /**
   * Trava o documento e, se ele ainda não tem número, a sequência da série.
   * Entrega o número a `build` e, se `build` concluir, grava número, chave, XML
   * assinado e o caminho de estados numa única transação.
   *
   * Se `build` lançar, nada é gravado e o número não é consumido.
   */
  signWithNumber(
    input: TransitionRequest,
    build: (context: SigningContext) => Promise<SignedArtifact>,
  ): Promise<InvoiceRecord>;

  transition(input: TransitionRequest): Promise<InvoiceRecord>;

  /**
   * Registra o início de uma chamada à SEFAZ e aplica o caminho de estados,
   * antes de a chamada acontecer. Se o processo cair durante a chamada, a
   * tentativa fica aberta e é encontrada pela recuperação.
   */
  beginAttempt(input: AttemptRequest): Promise<AttemptStart>;

  /** Conclui uma tentativa aberta. Tentativa já concluída é conflito. */
  finishAttempt(input: AttemptCompletion): Promise<InvoiceRecord>;

  findUnfinishedAttempts(input: UnfinishedAttemptQuery): Promise<readonly UnfinishedAttempt[]>;
}

export interface Clock {
  now(): Date;
}

export interface SigningRequest {
  readonly tenantId: string;
  readonly issuerId: string;
  readonly unsignedXml: string;
  /** Instante da emissão, usado também para conferir a validade do certificado. */
  readonly now: Date;
}

/**
 * Assina o XML com o certificado do emitente.
 *
 * Recusas esperadas (certificado vencido, chave divergente) devem chegar como
 * `SigningRefusedError`. Qualquer outro erro é tratado como falha interna.
 */
export interface XmlSigner {
  sign(request: SigningRequest): Promise<string>;
}

export interface SchemaProblem {
  readonly technicalMessage: string;
  readonly explanation: string;
}

export interface SchemaValidator {
  validate(xml: string): { readonly valid: boolean; readonly errors: readonly SchemaProblem[] };
}
