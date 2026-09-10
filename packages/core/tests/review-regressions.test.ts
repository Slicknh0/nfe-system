/**
 * Regressões encontradas na revisão de código de 2026-09-10.
 *
 * Cada bloco reproduz um defeito real encontrado por revisão nos dois eixos
 * (padrões e especificação). Nenhum deles havia sido pego pela suíte original —
 * os testes existentes verificavam o caminho declarado, não o caminho possível.
 */

import { describe, expect, it } from 'vitest';
import { Decimal, DecimalError, RoundingMode, allocate } from '../src/money/decimal.js';
import { buildAccessKey, type AccessKeyInput } from '../src/fiscal/access-key.js';
import { NfeStatus, canReachTransmissionWithoutResolution } from '../src/nfe/state-machine.js';

const baseKey: AccessKeyInput = {
  cUF: 35,
  issueDate: new Date('2026-06-15T12:00:00-03:00'),
  cnpj: '11222333000181',
  model: 55,
  series: 1,
  number: 1,
  tpEmis: 1,
  cNF: '12345678',
};

describe('BUG 1 — rateio com pesos muito pequenos', () => {
  it('não estoura divisão por zero quando os pesos são fracionários mínimos', () => {
    // Os pesos passavam pela guarda `totalWeight > 0` (soma float positiva) e só
    // então eram achatados para zero na conversão para inteiro, provocando um
    // RangeError cru no meio de uma emissão.
    expect(() => allocate(Decimal.parse('100.00'), [1e-7, 2e-7], 2)).not.toThrow(RangeError);
  });

  it('quando falha, falha com o erro tipado do módulo', () => {
    try {
      allocate(Decimal.parse('100.00'), [1e-12, 1e-12], 2);
    } catch (error) {
      expect(error).toBeInstanceOf(DecimalError);
    }
  });

  it('mantém a proporção mesmo com pesos de magnitude minúscula', () => {
    const parts = allocate(Decimal.parse('90.00'), [1e-7, 2e-7], 2);
    expect(parts.map((p) => p.toFixed(2))).toEqual(['30.00', '60.00']);
  });
});

describe('BUG 2 — item fora do rateio não pode receber centavo', () => {
  it('não distribui resto para parte de peso zero', () => {
    // Um item excluído do rateio de frete/desconto recebia R$ 0,01 do resto,
    // porque a distribuição do resto começava sempre no índice 0.
    const parts = allocate(Decimal.parse('0.05'), [0, 1, 1, 1], 2);
    expect(parts[0]?.toFixed(2)).toBe('0.00');
  });

  it('ainda fecha o total exatamente', () => {
    const parts = allocate(Decimal.parse('0.05'), [0, 1, 1, 1], 2);
    const sum = parts.reduce((acc, p) => acc.plus(p), Decimal.ZERO);
    expect(sum.toFixed(2)).toBe('0.05');
  });

  it('vale também quando o peso zero está no meio da lista', () => {
    const parts = allocate(Decimal.parse('0.07'), [1, 0, 1], 2);
    expect(parts[1]?.toFixed(2)).toBe('0.00');
    expect(
      parts.reduce((acc, p) => acc.plus(p), Decimal.ZERO).toFixed(2),
    ).toBe('0.07');
  });
});

describe('BUG 3 — AAMM da chave deve seguir a data local de emissão', () => {
  it('não empurra a emissão para o mês seguinte por causa do fuso', () => {
    // 31/01 23:30 em Brasília é 01/02 02:30 UTC. Derivar AAMM do UTC gerava
    // chave com competência 2602 para uma nota emitida em janeiro.
    const key = buildAccessKey({
      ...baseKey,
      issueDate: new Date('2026-01-31T23:30:00-03:00'),
    });
    expect(key.slice(2, 6)).toBe('2601');
  });

  it('não puxa a emissão para o mês anterior no outro extremo', () => {
    // 01/02 00:30 em Brasília ainda é 01/02 — não pode virar 2601.
    const key = buildAccessKey({
      ...baseKey,
      issueDate: new Date('2026-02-01T00:30:00-03:00'),
    });
    expect(key.slice(2, 6)).toBe('2602');
  });
});

describe('BUG 4 — reconciliação não pode alcançar transmissão por caminho indireto', () => {
  it('não existe caminho de PENDING_RECONCILIATION até SENDING', () => {
    // A aresta direta havia sido removida, mas PENDING_RECONCILIATION alcançava
    // CONTINGENCY, e CONTINGENCY alcançava SENDING. O documento voltava a ser
    // transmitido — exatamente a duplicação que a invariante existe para impedir.
    expect(canReachTransmissionWithoutResolution(NfeStatus.PendingReconciliation)).toBe(false);
  });

  it('documento autorizado também nunca alcança transmissão', () => {
    expect(canReachTransmissionWithoutResolution(NfeStatus.Authorized)).toBe(false);
  });

  it('rascunho, esse sim, alcança transmissão', () => {
    expect(canReachTransmissionWithoutResolution(NfeStatus.Draft)).toBe(true);
  });
});

describe('BUG 5 — multiplicação não pode truncar em silêncio', () => {
  it('preserva o sinal de um produto muito pequeno', () => {
    const result = Decimal.parse('-0.0000000001').times(Decimal.parse('0.9'));
    expect(result.isNegative() || result.isZero()).toBe(true);
    expect(result.toString()).not.toBe('-0');
  });

  it('arredonda em vez de truncar quando a política pede', () => {
    // 0.0000000001 × 0.5 = 0.00000000005; em half-up sobe para 0.0000000001.
    const result = Decimal.parse('0.0000000001').times(
      Decimal.parse('0.5'),
      RoundingMode.HalfUp,
    );
    expect(result.toString()).toBe('0.0000000001');
  });

  it('trunca apenas quando explicitamente instruído', () => {
    const result = Decimal.parse('0.0000000001').times(
      Decimal.parse('0.5'),
      RoundingMode.Truncate,
    );
    expect(result.isZero()).toBe(true);
  });
});

describe('BUG 6 — política de arredondamento precisa alcançar o rateio', () => {
  it('toScaledUnits respeita a política informada', () => {
    // 0.125 em duas casas: half-up dá 13; half-even dá 12.
    expect(Decimal.parse('0.125').toScaledUnits(2, RoundingMode.HalfUp)).toBe(13n);
    expect(Decimal.parse('0.125').toScaledUnits(2, RoundingMode.HalfEven)).toBe(12n);
  });

  it('allocate aceita política de arredondamento', () => {
    const parts = allocate(Decimal.parse('100.00'), [1, 1, 1], 2, RoundingMode.HalfEven);
    const sum = parts.reduce((acc, p) => acc.plus(p), Decimal.ZERO);
    expect(sum.toFixed(2)).toBe('100.00');
  });
});
