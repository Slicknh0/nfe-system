import { describe, expect, it } from 'vitest';
import {
  InvalidTransitionError,
  NfeStatus,
  assertTransition,
  canReachTransmissionWithoutResolution,
  canTransition,
  isEditable,
  isResolved,
  isTerminal,
  reachableFrom,
} from '../src/nfe/state-machine.js';

describe('fluxo feliz', () => {
  it('percorre DRAFT até AUTHORIZED', () => {
    const happyPath: readonly NfeStatus[] = [
      NfeStatus.Draft,
      NfeStatus.Validating,
      NfeStatus.Validated,
      NfeStatus.Signed,
      NfeStatus.Queued,
      NfeStatus.Sending,
      NfeStatus.Processing,
      NfeStatus.Authorized,
    ];

    for (let i = 0; i < happyPath.length - 1; i += 1) {
      const from = happyPath[i]!;
      const to = happyPath[i + 1]!;
      expect(canTransition(from, to)).toBe(true);
    }
  });
});

describe('documento autorizado é imutável', () => {
  it('nunca volta para rascunho', () => {
    expect(canTransition(NfeStatus.Authorized, NfeStatus.Draft)).toBe(false);
  });

  it('não pode ser reenviado', () => {
    expect(canTransition(NfeStatus.Authorized, NfeStatus.Sending)).toBe(false);
    expect(canTransition(NfeStatus.Authorized, NfeStatus.Queued)).toBe(false);
  });

  it('não é editável', () => {
    expect(isEditable(NfeStatus.Authorized)).toBe(false);
  });

  it('só admite cancelamento como saída', () => {
    expect(reachableFrom(NfeStatus.Authorized)).toEqual([NfeStatus.Cancelled]);
  });

  it('lança erro tipado ao tentar transição proibida', () => {
    expect(() => assertTransition(NfeStatus.Authorized, NfeStatus.Draft)).toThrow(
      InvalidTransitionError,
    );
  });
});

describe('falha de comunicação nunca vira retransmissão', () => {
  it('erro de comunicação leva a reconciliação pendente', () => {
    expect(canTransition(NfeStatus.CommunicationError, NfeStatus.PendingReconciliation)).toBe(
      true,
    );
  });

  it('reconciliação pendente NÃO pode reenviar o documento', () => {
    // Reenviar aqui é exatamente o bug que gera NF-e duplicada quando a SEFAZ
    // autorizou mas a resposta se perdeu. A saída é consultar, não transmitir.
    expect(canTransition(NfeStatus.PendingReconciliation, NfeStatus.Sending)).toBe(false);
    expect(canTransition(NfeStatus.PendingReconciliation, NfeStatus.Queued)).toBe(false);
  });

  it('falha com desfecho conhecido antes do envio devolve à fila', () => {
    expect(canTransition(NfeStatus.Sending, NfeStatus.Queued)).toBe(true);
  });

  it('erro de comunicação só sai por reconciliação, nunca pela fila', () => {
    expect(reachableFrom(NfeStatus.CommunicationError)).toEqual([
      NfeStatus.PendingReconciliation,
    ]);
  });

  it('reconciliação resolve para o desfecho descoberto na consulta', () => {
    expect(canTransition(NfeStatus.PendingReconciliation, NfeStatus.Authorized)).toBe(true);
    expect(canTransition(NfeStatus.PendingReconciliation, NfeStatus.Rejected)).toBe(true);
    expect(canTransition(NfeStatus.PendingReconciliation, NfeStatus.Denied)).toBe(true);
  });
});

describe('rejeição é resposta de negócio, não falha técnica', () => {
  it('documento rejeitado volta a ser editável para correção', () => {
    expect(canTransition(NfeStatus.Rejected, NfeStatus.Draft)).toBe(true);
    expect(isEditable(NfeStatus.Rejected)).toBe(true);
  });

  it('erro de validação local volta para rascunho', () => {
    expect(canTransition(NfeStatus.LocalValidationError, NfeStatus.Draft)).toBe(true);
  });

  it('denegada é terminal — não se corrige e reemite com a mesma numeração', () => {
    expect(isTerminal(NfeStatus.Denied)).toBe(true);
    expect(canTransition(NfeStatus.Denied, NfeStatus.Draft)).toBe(false);
  });
});

describe('estados terminais', () => {
  it('cancelada e denegada não têm saída', () => {
    expect(reachableFrom(NfeStatus.Cancelled)).toEqual([]);
    expect(reachableFrom(NfeStatus.Denied)).toEqual([]);
    expect(isTerminal(NfeStatus.Cancelled)).toBe(true);
  });

  it('autorizada não é terminal — ainda admite cancelamento', () => {
    expect(isTerminal(NfeStatus.Authorized)).toBe(false);
  });
});

describe('inutilização encerra a numeração', () => {
  it('pendência, rejeição e rascunho reaberto podem ter o número inutilizado', () => {
    for (const from of [
      NfeStatus.PendingReconciliation,
      NfeStatus.Rejected,
      NfeStatus.LocalValidationError,
      NfeStatus.Draft,
    ]) {
      expect(canTransition(from, NfeStatus.NumberVoided)).toBe(true);
    }
  });

  it('documento autorizado, denegado ou em transmissão não tem o número inutilizado', () => {
    for (const from of [
      NfeStatus.Authorized,
      NfeStatus.Denied,
      NfeStatus.Cancelled,
      NfeStatus.Queued,
      NfeStatus.Sending,
      NfeStatus.Processing,
      NfeStatus.CommunicationError,
    ]) {
      expect(canTransition(from, NfeStatus.NumberVoided)).toBe(false);
    }
  });

  it('numeração inutilizada é desfecho definitivo e não abre caminho de retransmissão', () => {
    expect(isTerminal(NfeStatus.NumberVoided)).toBe(true);
    expect(isResolved(NfeStatus.NumberVoided)).toBe(true);
    expect(canReachTransmissionWithoutResolution(NfeStatus.PendingReconciliation)).toBe(false);
  });
});

describe('integridade do grafo', () => {
  it('todo estado declarado tem entrada no mapa de transições', () => {
    for (const status of Object.values(NfeStatus)) {
      expect(() => reachableFrom(status)).not.toThrow();
    }
  });

  it('nenhuma transição aponta para estado inexistente', () => {
    const known = new Set<string>(Object.values(NfeStatus));
    for (const status of Object.values(NfeStatus)) {
      for (const target of reachableFrom(status)) {
        expect(known.has(target)).toBe(true);
      }
    }
  });

  it('nenhum estado transiciona para si mesmo', () => {
    for (const status of Object.values(NfeStatus)) {
      expect(reachableFrom(status)).not.toContain(status);
    }
  });
});
