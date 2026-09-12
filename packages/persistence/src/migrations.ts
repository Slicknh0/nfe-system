/**
 * Migrador de SQL versionado.
 *
 * Deliberadamente pequeno: arquivos `NNNN_nome.sql` aplicados em ordem, numa
 * única transação, sob advisory lock (duas instâncias subindo juntas não
 * migram duas vezes). Cada migração aplicada guarda um checksum; editar um
 * arquivo já aplicado é recusado, porque o banco de produção não reflete mais
 * o que está no repositório.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

export const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../migrations/', import.meta.url));

const FILE_NAME = /^\d{4}_[a-z0-9_]+\.sql$/;
const MIGRATION_LOCK_KEY = 7_424_055;

export interface Migration {
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

export class MigrationIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationIntegrityError';
  }
}

/** Fim de linha normalizado: checkout com CRLF no Windows não muda o checksum. */
export function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

export function loadMigrations(directory: string = MIGRATIONS_DIRECTORY): readonly Migration[] {
  return readdirSync(directory)
    .filter((name) => FILE_NAME.test(name))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(directory, name), 'utf8');
      return { name, sql, checksum: migrationChecksum(sql) };
    });
}

/** Aplica as migrações pendentes e devolve os nomes aplicados. */
export async function migrate(
  pool: Pool,
  migrations: readonly Migration[] = loadMigrations(),
): Promise<readonly string[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        checksum   char(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const { rows } = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations ORDER BY name',
    );
    const local = new Map(migrations.map((migration) => [migration.name, migration]));
    for (const row of rows) {
      const migration = local.get(row.name);
      if (migration === undefined) {
        throw new MigrationIntegrityError(
          `A migração ${row.name} está aplicada no banco, mas não existe nesta versão do código.`,
        );
      }
      if (migration.checksum !== row.checksum) {
        throw new MigrationIntegrityError(`A migração ${row.name} foi alterada depois de aplicada.`);
      }
    }

    const applied = new Set(rows.map((row) => row.name));
    const latestApplied = rows.at(-1)?.name;
    const pending = migrations.filter((migration) => !applied.has(migration.name));
    const outOfOrder = pending.find(
      (migration) => latestApplied !== undefined && migration.name < latestApplied,
    );
    if (outOfOrder !== undefined) {
      throw new MigrationIntegrityError(
        `A migração ${outOfOrder.name} é anterior à última aplicada (${latestApplied ?? ''}).`,
      );
    }

    for (const migration of pending) {
      await client.query(migration.sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
        migration.name,
        migration.checksum,
      ]);
    }
    await client.query('COMMIT');
    return pending.map((migration) => migration.name);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
