import { getTableColumns, getTableName } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MigrationIntegrityError,
  loadMigrations,
  migrate,
  migrationChecksum,
  schema,
} from '../src/index.js';
import { createTestDatabase, type TestDatabase } from './support/database.js';

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.dispose();
});

describe('migrador', () => {
  it('aplica tudo uma vez; reaplicar não faz nada', async () => {
    const { rows } = await database.admin.query<{ name: string }>(
      'SELECT name FROM schema_migrations ORDER BY name',
    );
    expect(rows.map((row) => row.name)).toEqual(loadMigrations().map((migration) => migration.name));
    expect(await migrate(database.admin)).toEqual([]);
  });

  it('recusa migração alterada depois de aplicada', async () => {
    const altered = loadMigrations().map((migration, index) =>
      index === 0 ? { ...migration, checksum: migrationChecksum(`${migration.sql}\n-- editada`) } : migration,
    );
    await expect(migrate(database.admin, altered)).rejects.toBeInstanceOf(MigrationIntegrityError);
  });

  it('recusa banco com migração que esta versão do código não conhece', async () => {
    await expect(migrate(database.admin, loadMigrations().slice(0, 1))).rejects.toBeInstanceOf(
      MigrationIntegrityError,
    );
  });

  it('checksum não depende do fim de linha do checkout', () => {
    expect(migrationChecksum('SELECT 1;\r\nSELECT 2;\r\n')).toBe(migrationChecksum('SELECT 1;\nSELECT 2;\n'));
  });
});

describe('mapeamento Drizzle', () => {
  it.each([
    schema.tenants,
    schema.issuers,
    schema.numberSequences,
    schema.invoices,
    schema.invoiceStatusHistory,
    schema.sefazAttempts,
  ])('corresponde às colunas criadas pelas migrations', async (table) => {
    const { rows } = await database.admin.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1`,
      [getTableName(table)],
    );
    const inDatabase = Object.fromEntries(rows.map((row) => [row.column_name, row.is_nullable === 'NO']));
    const inDrizzle = Object.fromEntries(
      Object.values(getTableColumns(table)).map((column) => [column.name, column.notNull]),
    );
    expect(inDrizzle).toEqual(inDatabase);
  });
});
