import { Decimal, InvalidTransitionError, NfeStatus } from '@nfe/core';
import { describe, expect, it } from 'vitest';
import {
  assertStatusPath,
  canonicalJson,
  decodeDocument,
  draftRequestHash,
  encodeDocument,
  type DraftDocument,
} from '../src/index.js';
import { makeDraft, withIdentification } from './support/fixtures.js';

describe('codificação do rascunho', () => {
  it('ida e volta por JSON preserva Decimal e Date sem passar por float', () => {
    const draft = makeDraft();
    const roundTrip = decodeDocument(JSON.parse(JSON.stringify(encodeDocument(draft)))) as DraftDocument;

    const price = roundTrip.items[0]!.unitPrice;
    expect(price).toBeInstanceOf(Decimal);
    expect(price.toFixed(2)).toBe('49.90');
    expect(draftRequestHash('emitente', roundTrip)).toBe(draftRequestHash('emitente', draft));
  });

  it('valor monetário é gravado como texto exato', () => {
    expect(encodeDocument({ total: Decimal.parse('0.1').plus(Decimal.parse('0.2')) })).toEqual({
      total: { $decimal: '0.3' },
    });
  });

  it('data é gravada em ISO e restaurada como Date', () => {
    const encoded = encodeDocument({ at: new Date('2026-09-11T13:00:00.000Z') });
    expect(encoded).toEqual({ at: { $date: '2026-09-11T13:00:00.000Z' } });
    expect((decodeDocument(encoded) as { at: Date }).at).toEqual(new Date('2026-09-11T13:00:00.000Z'));
  });

  it('omite campos indefinidos e recusa número não finito', () => {
    expect(encodeDocument({ a: 1, b: undefined })).toEqual({ a: 1 });
    expect(() => encodeDocument({ a: Number.NaN })).toThrow();
  });
});

describe('impressão digital da requisição', () => {
  it('não depende da ordem das chaves', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it('muda quando muda o conteúdo ou o emitente', () => {
    const draft = makeDraft();
    const base = draftRequestHash('emitente', draft);
    expect(draftRequestHash('outro-emitente', draft)).not.toBe(base);
    expect(draftRequestHash('emitente', withIdentification(draft, { series: 2 }))).not.toBe(base);
  });
});

describe('assertStatusPath', () => {
  it('devolve o estado final de um caminho válido', () => {
    expect(assertStatusPath([NfeStatus.Queued, NfeStatus.Sending, NfeStatus.Authorized])).toBe(
      NfeStatus.Authorized,
    );
  });

  it('recusa caminho vazio e salto inválido', () => {
    expect(() => assertStatusPath([])).toThrow();
    expect(() => assertStatusPath([NfeStatus.PendingReconciliation, NfeStatus.Sending])).toThrow(
      InvalidTransitionError,
    );
  });
});
