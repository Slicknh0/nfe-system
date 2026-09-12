/**
 * Conexão e transação com escopo de tenant.
 *
 * Toda operação de negócio passa por `withTenant`, que abre a transação e fixa
 * `app.tenant_id` só para ela (`set_config(..., true)`). As políticas de RLS
 * das migrations usam esse valor: sem ele, nenhuma linha é visível. Assim o
 * isolamento não depende de cada consulta lembrar o filtro por tenant.
 */

import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export function createDatabase(pool: Pool): Database {
  return drizzle({ client: pool, schema });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

export class InvalidTenantError extends Error {
  constructor() {
    super('Identificador de tenant inválido.');
    this.name = 'InvalidTenantError';
  }
}

export async function withTenant<T>(
  db: Database,
  tenantId: string,
  work: (tx: Transaction) => Promise<T>,
): Promise<T> {
  if (!isUuid(tenantId)) {
    throw new InvalidTenantError();
  }
  return await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return await work(tx);
  });
}
