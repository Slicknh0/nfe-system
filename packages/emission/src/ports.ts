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
  VoidProtocol,
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
  | 'VOIDED'
  | 'RANGE_ALREADY_VOIDED'
  | 'NUMBER_ALREADY_USED'
  | 'NOT_SENT'
  | 'NO_RESPONSE'
  | 'ABANDONED';

/** Situação do pedido de inutilização vinculado a um documento. */
export type NumberVoidStatus = 'REQUESTED' | 'VOIDED' | 'REJECTED';

/** Pedido de inutilização montado e assinado, prestes a ser enviado. */
export interface NumberVoidDraft {
  readonly year: number;
  readonly justification: string;
  /** Atributo `Id` de `infInut`. */
  readonly requestId: string;
  readonly signedXml: string;
}

export interface NumberVoidRecord extends NumberVoidDraft {
  readonly invoiceId: string;
  readonly series: number;
  readonly firstNumber: number;
  readonly lastNumber: number;
  readonly status: NumberVoidStatus;
  readonly protocol?: VoidProtocol;
  readonly lastStatus?: StatusReply;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface NumberVoidUpdate {
  readonly status: NumberVoidStatus;
  readonly protocol?: VoidProtocol;
}

export interface AttemptRequest extends TransitionRequest {
  readonly operation: SefazOperation;
  /** Obrigatório quando `operation` é `NUMBER_VOID`; proibido nas demais. */
  readonly numberVoid?: NumberVoidDraft;
}

export interface AttemptStart {
  readonly invoice: InvoiceRecord;
  readonly attemptId: string;
}

export interface AttemptCompletion extends TransitionRequest {
  readonly attemptId: string;
  readonly outcome: AttemptOutcome;
  readonly protocol?: InvoiceProtocol;
  /** Situação do pedido de inutilização, quando a tentativa for de inutilização. */
  readonly numberVoid?: NumberVoidUpdate;
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

export interface AttemptSummary {
  readonly attemptId: string;
  readonly operation: SefazOperation;
  readonly startedAt: Date;
  readonly finishedAt?: Date;
  readonly outcome?: AttemptOutcome;
  readonly statusCode?: number;
}

export interface InvoiceListQuery {
  readonly tenantId: string;
  readonly statuses: readonly NfeStatus[];
  readonly limit: number;
}

export interface EmissionStore {
  /** Idempotente por `(tenantId, idempotencyKey)`. Conteúdo diferente com a mesma chave é conflito. */
  createDraft(input: NewDraft): Promise<DraftCreation>;

  findInvoice(tenantId: string, invoiceId: string): Promise<InvoiceRecord | undefined>;

  findHistory(tenantId: string, invoiceId: string): Promise<readonly StatusHistoryEntry[]>;

  /** Tentativas de comunicação do documento, da mais antiga para a mais recente. */
  findAttempts(tenantId: string, invoiceId: string): Promise<readonly AttemptSummary[]>;

  findNumberVoid(tenantId: string, invoiceId: string): Promise<NumberVoidRecord | undefined>;

  /** Documentos nos estados pedidos, dos atualizados há mais tempo para os mais recentes. */
  listInvoices(query: InvoiceListQuery): Promise<readonly InvoiceRecord[]>;

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
   *
   * Com `numberVoid`, grava (ou regrava, se ainda não homologado) o pedido de
   * inutilização do número do documento.
   */
  beginAttempt(input: AttemptRequest): Promise<AttemptStart>;

  /** Conclui uma tentativa aberta. Tentativa já concluída é conflito. */
  finishAttempt(input: AttemptCompletion): Promise<InvoiceRecord>;

  findUnfinishedAttempts(input: UnfinishedAttemptQuery): Promise<readonly UnfinishedAttempt[]>;
}

export interface Clock {
  now(): Date;
}

/** Documento que a aplicação assina e valida contra o XSD. */
export type SignableDocument = 'NFE' | 'INUTILIZATION';

export interface SigningRequest {
  readonly tenantId: string;
  readonly issuerId: string;
  readonly document: SignableDocument;
  readonly unsignedXml: string;
  /** Instante da operação, usado também para conferir a validade do certificado. */
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
  validate(
    xml: string,
    document: SignableDocument,
  ): { readonly valid: boolean; readonly errors: readonly SchemaProblem[] };
}
