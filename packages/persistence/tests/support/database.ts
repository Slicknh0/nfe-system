/**
 * Um banco novo por arquivo de teste, migrado, com o papel restrito da
 * aplicação. Cada teste cria os próprios tenants, então não há estado
 * compartilhado entre testes.
 */

import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import {
  createDatabase,
  createIssuer,
  createTenant,
  grantApplicationAccess,
  migrate,
  type Database,
} from '../../src/index.js';
import type {} from './global-setup.js';

export interface TestDatabase {
  /** Superusuário: migrações e verificações que precisam contornar RLS. */
  readonly admin: pg.Pool;
  /** Papel restrito da aplicação, sujeito a RLS. */
  readonly app: pg.Pool;
  readonly db: Database;
  dispose(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const server = inject('postgres');
  const name = `nfe_test_${randomBytes(6).toString('hex')}`;
  const connection = { host: server.host, port: server.port };

  const root = new pg.Client({
    ...connection,
    user: server.adminUser,
    password: server.adminPassword,
    database: 'postgres',
  });
  await root.connect();
  try {
    await root.query(`CREATE DATABASE ${pg.escapeIdentifier(name)}`);
  } finally {
    await root.end();
  }

  const admin = new pg.Pool({
    ...connection,
    user: server.adminUser,
    password: server.adminPassword,
    database: name,
    max: 4,
  });
  await migrate(admin);
  await grantApplicationAccess(admin, server.appUser);

  const app = new pg.Pool({
    ...connection,
    user: server.appUser,
    password: server.appPassword,
    database: name,
    max: 24,
  });

  return {
    admin,
    app,
    db: createDatabase(app),
    dispose: async () => {
      await app.end();
      await admin.end();
    },
  };
}

export interface TenantScope {
  readonly tenantId: string;
  readonly issuerId: string;
}

export async function createScope(
  db: Database,
  label: string,
  cnpj = '11222333000181',
): Promise<TenantScope> {
  const tenantId = await createTenant(db, `Tenant ${label}`);
  const issuerId = await createIssuer(db, tenantId, { cnpj, legalName: `Emitente ${label}` });
  return { tenantId, issuerId };
}
