/**
 * Tradução de violações das invariantes do banco.
 *
 * Um SQLSTATE da classe NFE significa que a aplicação tentou algo que a
 * máquina de estados deveria ter impedido — é defeito, não erro de usuário.
 */

const INVARIANTS: Readonly<Record<string, string>> = Object.freeze({
  NFE01: 'tabela somente inserção',
  NFE02: 'documento autorizado, denegado ou cancelado',
  NFE03: 'reconciliação pendente só sai por desfecho descoberto',
  NFE04: 'identidade ou número do documento',
  NFE05: 'conteúdo de documento em transmissão',
  NFE06: 'tentativa de comunicação concluída',
  NFE07: 'pedido de inutilização homologado',
});

export class PersistenceInvariantError extends Error {
  constructor(
    readonly sqlState: string,
    readonly invariant: string,
    message: string,
    options?: { cause: unknown },
  ) {
    super(`Invariante do banco violada (${invariant}): ${message}`, options);
    this.name = 'PersistenceInvariantError';
  }
}

/** SQLSTATE do erro, procurando também em `cause` (o Drizzle embrulha o erro do driver). */
export function sqlStateOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && typeof current === 'object'; depth += 1) {
    if ('code' in current && typeof current.code === 'string') {
      return current.code;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

export function translateDatabaseError(error: unknown): unknown {
  const sqlState = sqlStateOf(error);
  const invariant = sqlState === undefined ? undefined : INVARIANTS[sqlState];
  if (sqlState === undefined || invariant === undefined) {
    return error;
  }
  const message = error instanceof Error ? error.message : 'sem detalhe';
  return new PersistenceInvariantError(sqlState, invariant, message, { cause: error });
}
