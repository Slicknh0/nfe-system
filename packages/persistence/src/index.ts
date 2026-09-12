/**
 * `@nfe/persistence` — Postgres: migrations, isolamento por tenant (RLS),
 * invariantes fiscais no banco e o adaptador de `EmissionStore`.
 */

export {
  InvalidTenantError,
  createDatabase,
  isUuid,
  withTenant,
  type Database,
  type Transaction,
} from './database.js';

export {
  MIGRATIONS_DIRECTORY,
  MigrationIntegrityError,
  loadMigrations,
  migrate,
  migrationChecksum,
  type Migration,
} from './migrations.js';

export { UnsafeDatabaseRoleError, assertRestrictedRole, grantApplicationAccess } from './roles.js';

export { PersistenceInvariantError, sqlStateOf, translateDatabaseError } from './errors.js';

export { createIssuer, createTenant, type NewIssuer } from './tenants.js';

export { PostgresEmissionStore } from './postgres-emission-store.js';

export * as schema from './schema.js';
