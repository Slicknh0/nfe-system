/**
 * Quando consultar uma NF-e pendente de retorno, e quando liberar a
 * inutilização do seu número.
 *
 * O que é oficial (MOC 7.0, Anexo III, 2.3.3): a nota pendente de retorno pode
 * não ter chegado, estar na fila ou já estar autorizada; as que não forem
 * autorizadas nem denegadas têm a numeração inutilizada. A consulta com 217 não
 * prova que a nota não esteja na fila.
 *
 * O que NÃO é oficial, e por isso é parâmetro: quantas consultas fazer, em que
 * intervalo, e quanto esperar antes de inutilizar. Os valores padrão são
 * decisão arquitetural. O espaçamento crescente evita o "consumo indevido"
 * descrito no MOC (Visão Geral, tabela 4-9: consulta repetida em looping).
 *
 * A inutilização em si continua segura mesmo se a política errar para menos:
 * se a nota tiver sido processada, a SEFAZ recusa com 241 e a consulta decide.
 */

import { NfeStatus } from '@nfe/core';
import type { AttemptOutcome, AttemptSummary, InvoiceRecord } from './ports.js';

const MINUTE = 60_000;

export interface ReconciliationPolicy {
  /** Espera após o último envio sem resposta antes da primeira consulta. */
  readonly firstQueryDelayMs: number;
  /** Intervalo antes de cada consulta seguinte; o último valor se repete. */
  readonly queryIntervalsMs: readonly number[];
  /** Consultas com 217 (desde o último envio) exigidas para liberar a inutilização. */
  readonly notFoundQueriesBeforeVoid: number;
  /** Tempo mínimo desde o último envio para liberar a inutilização. */
  readonly minimumAgeBeforeVoidMs: number;
}

export const DEFAULT_RECONCILIATION_POLICY: ReconciliationPolicy = Object.freeze({
  firstQueryDelayMs: MINUTE,
  queryIntervalsMs: Object.freeze([2 * MINUTE, 5 * MINUTE, 15 * MINUTE, 30 * MINUTE, 60 * MINUTE]),
  notFoundQueriesBeforeVoid: 3,
  minimumAgeBeforeVoidMs: 60 * MINUTE,
});

export type ReconciliationPlan =
  | { readonly action: 'NOT_APPLICABLE' }
  | { readonly action: 'QUERY_NOW' }
  | { readonly action: 'WAIT'; readonly notBefore: Date }
  | { readonly action: 'VOID_ALLOWED'; readonly notFoundQueries: number };

/**
 * Respostas que contradizem "a SEFAZ não tem a nota" e exigem atenção: zeram a
 * contagem de 217. Falha técnica na consulta não confirma nem contradiz nada, e
 * não entra na conta.
 */
const CONTRADICTING_ANSWERS = new Set<AttemptOutcome>([
  'CANCELLED',
  'QUERY_REJECTED',
  'UNRECOGNIZED',
  'PROTOCOL_MISMATCH',
]);

export function planReconciliation(
  invoice: InvoiceRecord,
  attempts: readonly AttemptSummary[],
  now: Date,
  policy: ReconciliationPolicy = DEFAULT_RECONCILIATION_POLICY,
): ReconciliationPlan {
  if (
    invoice.status !== NfeStatus.PendingReconciliation &&
    invoice.status !== NfeStatus.Processing
  ) {
    return { action: 'NOT_APPLICABLE' };
  }

  const ordered = [...attempts].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  const lastSendAt =
    ordered.filter((attempt) => attempt.operation === 'AUTHORIZATION').at(-1)?.startedAt ??
    invoice.updatedAt;
  const queries = ordered.filter(
    (attempt) => attempt.operation === 'PROTOCOL_QUERY' && attempt.startedAt >= lastSendAt,
  );

  let notFoundQueries = 0;
  for (const query of queries) {
    if (query.outcome === 'NOT_FOUND') {
      notFoundQueries += 1;
    } else if (query.outcome !== undefined && CONTRADICTING_ANSWERS.has(query.outcome)) {
      notFoundQueries = 0;
    }
  }

  if (
    invoice.status === NfeStatus.PendingReconciliation &&
    notFoundQueries >= policy.notFoundQueriesBeforeVoid &&
    now.getTime() - lastSendAt.getTime() >= policy.minimumAgeBeforeVoidMs
  ) {
    return { action: 'VOID_ALLOWED', notFoundQueries };
  }

  const lastQuery = queries.at(-1);
  const nextQueryAt =
    lastQuery === undefined
      ? lastSendAt.getTime() + policy.firstQueryDelayMs
      : lastQuery.startedAt.getTime() + intervalAfter(policy, queries.length);

  return now.getTime() >= nextQueryAt
    ? { action: 'QUERY_NOW' }
    : { action: 'WAIT', notBefore: new Date(nextQueryAt) };
}

function intervalAfter(policy: ReconciliationPolicy, queriesSoFar: number): number {
  const intervals = policy.queryIntervalsMs;
  return intervals[Math.min(queriesSoFar - 1, intervals.length - 1)] ?? intervals.at(-1) ?? 0;
}
