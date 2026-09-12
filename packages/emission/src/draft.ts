/**
 * Rascunho, caminho de estados e codificação para persistência.
 */

import { createHash } from 'node:crypto';
import { Decimal, NfeStatus, assertTransition, type NfeDocument } from '@nfe/core';
import type { DraftDocument } from './ports.js';

export interface IssuanceAssignment {
  readonly number: number;
  readonly randomCode: string;
  readonly issuedAt: Date;
}

export function completeDraft(draft: DraftDocument, assignment: IssuanceAssignment): NfeDocument {
  return {
    ...draft,
    identification: { ...draft.identification, ...assignment },
  };
}

/** Valida cada salto do caminho contra a máquina de estados. */
export function assertStatusPath(path: readonly NfeStatus[]): NfeStatus {
  const [first, ...rest] = path;
  if (first === undefined) {
    throw new Error('Caminho de estados vazio.');
  }
  let current = first;
  for (const next of rest) {
    assertTransition(current, next);
    current = next;
  }
  return current;
}

/** Caminho do estado editável atual até `DRAFT`. */
export function pathToDraft(status: NfeStatus): readonly NfeStatus[] {
  return status === NfeStatus.Draft ? [NfeStatus.Draft] : [status, NfeStatus.Draft];
}

export type EncodedValue =
  | null
  | boolean
  | number
  | string
  | readonly EncodedValue[]
  | { readonly [key: string]: EncodedValue };

const DECIMAL_TAG = '$decimal';
const DATE_TAG = '$date';

/**
 * Converte o documento em JSON sem perder tipo: `Decimal` vira string exata e
 * `Date` vira ISO, ambos marcados. Número em ponto flutuante nunca carrega
 * valor monetário.
 */
export function encodeDocument(value: unknown): EncodedValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Número não finito no documento.');
    }
    return value;
  }
  if (value instanceof Decimal) {
    return { [DECIMAL_TAG]: value.toString() };
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error('Data inválida no documento.');
    }
    return { [DATE_TAG]: value.toISOString() };
  }
  if (Array.isArray(value)) {
    return value.map((item) => encodeDocument(item));
  }
  if (typeof value === 'object') {
    const encoded: Record<string, EncodedValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) {
        encoded[key] = encodeDocument(item);
      }
    }
    return encoded;
  }
  throw new Error(`Tipo não serializável no documento: ${typeof value}.`);
}

export function decodeDocument(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => decodeDocument(item));
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 1) {
      const [[key, item]] = entries as [[string, unknown]];
      if (key === DECIMAL_TAG && typeof item === 'string') {
        return Decimal.parse(item);
      }
      if (key === DATE_TAG && typeof item === 'string') {
        return new Date(item);
      }
    }
    return Object.fromEntries(entries.map(([key, item]) => [key, decodeDocument(item)]));
  }
  return value;
}

/** JSON com chaves ordenadas: o mesmo conteúdo produz sempre os mesmos bytes. */
export function canonicalJson(value: EncodedValue): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${(value as readonly EncodedValue[]).map((item) => canonicalJson(item)).join(',')}]`;
  }
  const record = value as { readonly [key: string]: EncodedValue };
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key] ?? null)}`).join(',')}}`;
}

/** Impressão digital da requisição de criação, para detectar reuso indevido da chave. */
export function draftRequestHash(issuerId: string, draft: DraftDocument): string {
  const payload = canonicalJson({ issuerId, draft: encodeDocument(draft) });
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}
