import { calculateCnpjCheckDigits } from '@nfe/core';
import { afterAll, beforeAll } from 'vitest';
import { describeEmissionStoreContract } from '../../emission/tests/support/emission-store-contract.js';
import { PostgresEmissionStore } from '../src/index.js';
import { createScope, createTestDatabase, type TestDatabase } from './support/database.js';

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.dispose();
});

describeEmissionStoreContract('Postgres com RLS', async () => ({
  store: new PostgresEmissionStore(database.db),
  tenantA: await createScope(database.db, 'A'),
  tenantB: await createScope(
    database.db,
    'B',
    `A1B2C3D4E5F6${calculateCnpjCheckDigits('A1B2C3D4E5F6')}`,
  ),
}));
