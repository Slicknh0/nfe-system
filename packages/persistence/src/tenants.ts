/**
 * Cadastro mínimo de tenant e emitente — o necessário para emitir.
 */

import { randomUUID } from 'node:crypto';
import { assertValidCnpj } from '@nfe/core';
import { withTenant, type Database } from './database.js';
import { issuers, tenants } from './schema.js';

export async function createTenant(db: Database, name: string): Promise<string> {
  const id = randomUUID();
  await withTenant(db, id, async (tx) => {
    await tx.insert(tenants).values({ id, name });
  });
  return id;
}

export interface NewIssuer {
  readonly cnpj: string;
  readonly legalName: string;
}

export async function createIssuer(db: Database, tenantId: string, input: NewIssuer): Promise<string> {
  const cnpj = assertValidCnpj(input.cnpj);
  const [row] = await withTenant(db, tenantId, (tx) =>
    tx
      .insert(issuers)
      .values({ tenantId, cnpj, legalName: input.legalName })
      .returning({ id: issuers.id })
      .then((rows) => rows),
  );
  if (row === undefined) {
    throw new Error('O emitente não foi criado.');
  }
  return row.id;
}
