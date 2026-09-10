/**
 * Máquina de estados do documento NF-e.
 *
 * As transições são declaradas como dado, não como cadeia de `if`. Isso permite
 * testar o grafo inteiro, renderizar a timeline na UI a partir da mesma fonte e
 * impedir que uma regra crítica seja contornada por um caminho de código novo.
 *
 * Duas invariantes têm peso fiscal e estão cobertas por teste:
 *
 * 1. `AUTHORIZED` jamais volta para edição. O documento autorizado é o documento
 *    oficial; alterá-lo criaria divergência entre banco, XML, protocolo e DANFE.
 *
 * 2. `PENDING_RECONCILIATION` não tem aresta para `SENDING` nem `QUEUED`. Quando
 *    a resposta da SEFAZ se perde, a única saída é *consultar* o resultado. Uma
 *    aresta de retransmissão aqui é o caminho direto para NF-e duplicada.
 */

export enum NfeStatus {
  Draft = 'DRAFT',
  Validating = 'VALIDATING',
  Validated = 'VALIDATED',
  Signed = 'SIGNED',
  Queued = 'QUEUED',
  Sending = 'SENDING',
  Processing = 'PROCESSING',
  Authorized = 'AUTHORIZED',

  LocalValidationError = 'LOCAL_VALIDATION_ERROR',
  Rejected = 'REJECTED',
  CommunicationError = 'COMMUNICATION_ERROR',
  PendingReconciliation = 'PENDING_RECONCILIATION',
  Contingency = 'CONTINGENCY',
  Denied = 'DENIED',
  Cancelled = 'CANCELLED',
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: NfeStatus,
    readonly to: NfeStatus,
  ) {
    super(`Transição inválida de ${from} para ${to}.`);
    this.name = 'InvalidTransitionError';
  }
}

const TRANSITIONS: Readonly<Record<NfeStatus, readonly NfeStatus[]>> = Object.freeze({
  [NfeStatus.Draft]: [NfeStatus.Validating],

  [NfeStatus.Validating]: [NfeStatus.Validated, NfeStatus.LocalValidationError],

  [NfeStatus.Validated]: [NfeStatus.Signed, NfeStatus.LocalValidationError],

  [NfeStatus.Signed]: [NfeStatus.Queued, NfeStatus.LocalValidationError],

  [NfeStatus.Queued]: [NfeStatus.Sending, NfeStatus.Contingency],

  [NfeStatus.Sending]: [
    NfeStatus.Processing,
    NfeStatus.Authorized,
    NfeStatus.Rejected,
    NfeStatus.Denied,
    NfeStatus.CommunicationError,
  ],

  // Recibo aceito e em processamento: resolve por consulta de recibo.
  [NfeStatus.Processing]: [
    NfeStatus.Authorized,
    NfeStatus.Rejected,
    NfeStatus.Denied,
    NfeStatus.CommunicationError,
  ],

  // Falha técnica. Não se sabe se a SEFAZ processou — vai para reconciliação.
  [NfeStatus.CommunicationError]: [NfeStatus.PendingReconciliation],

  // Saídas apenas por descoberta via consulta. Sem aresta de retransmissão.
  [NfeStatus.PendingReconciliation]: [
    NfeStatus.Authorized,
    NfeStatus.Rejected,
    NfeStatus.Denied,
    NfeStatus.Contingency,
  ],

  [NfeStatus.Contingency]: [
    NfeStatus.Sending,
    NfeStatus.Authorized,
    NfeStatus.Rejected,
    NfeStatus.CommunicationError,
  ],

  // Rejeição é resposta de negócio: o contribuinte corrige e reemite.
  [NfeStatus.Rejected]: [NfeStatus.Draft],

  [NfeStatus.LocalValidationError]: [NfeStatus.Draft],

  // Documento oficial. Única saída é o evento de cancelamento confirmado.
  [NfeStatus.Authorized]: [NfeStatus.Cancelled],

  [NfeStatus.Denied]: [],

  [NfeStatus.Cancelled]: [],
});

/** Estados em que o documento ainda admite edição de conteúdo fiscal. */
const EDITABLE = new Set<NfeStatus>([
  NfeStatus.Draft,
  NfeStatus.LocalValidationError,
  NfeStatus.Rejected,
]);

export function reachableFrom(status: NfeStatus): readonly NfeStatus[] {
  const targets = TRANSITIONS[status];
  if (targets === undefined) {
    throw new Error(`Estado ${status} não declarado no mapa de transições.`);
  }
  return targets;
}

export function canTransition(from: NfeStatus, to: NfeStatus): boolean {
  return reachableFrom(from).includes(to);
}

/** Versão que lança — usada no serviço de domínio, onde a violação é bug. */
export function assertTransition(from: NfeStatus, to: NfeStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }
}

export function isTerminal(status: NfeStatus): boolean {
  return reachableFrom(status).length === 0;
}

export function isEditable(status: NfeStatus): boolean {
  return EDITABLE.has(status);
}
