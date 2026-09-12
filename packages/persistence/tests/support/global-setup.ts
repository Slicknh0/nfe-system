/**
 * Postgres real para os testes, sem Docker: binário oficial via
 * `embedded-postgres`, num diretório temporário, numa porta livre.
 *
 * Senhas geradas a cada execução e mantidas só em memória. O papel da
 * aplicação (`nfe_app`) é criado sem superusuário e sem BYPASSRLS — é com ele
 * que os testes exercitam o isolamento entre tenants.
 */

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import type { GlobalSetupContext } from 'vitest/node';

export interface TestPostgresServer {
  readonly host: string;
  readonly port: number;
  readonly adminUser: string;
  readonly adminPassword: string;
  readonly appUser: string;
  readonly appPassword: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    postgres: TestPostgresServer;
  }
}

const HOST = '127.0.0.1';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Não foi possível reservar uma porta.'));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

export default async function setup({ provide }: GlobalSetupContext): Promise<() => Promise<void>> {
  const databaseDir = mkdtempSync(join(tmpdir(), 'nfe-pg-'));
  const port = await freePort();
  const credentials: TestPostgresServer = {
    host: HOST,
    port,
    adminUser: 'postgres',
    adminPassword: randomBytes(24).toString('base64url'),
    appUser: 'nfe_app',
    appPassword: randomBytes(24).toString('base64url'),
  };

  const server = new EmbeddedPostgres({
    databaseDir,
    port,
    user: credentials.adminUser,
    password: credentials.adminPassword,
    persistent: false,
    onLog: () => undefined,
  });
  await server.initialise();
  await server.start();

  const client = new pg.Client({
    host: HOST,
    port,
    user: credentials.adminUser,
    password: credentials.adminPassword,
    database: 'postgres',
  });
  await client.connect();
  try {
    await client.query(
      `CREATE ROLE ${pg.escapeIdentifier(credentials.appUser)} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${pg.escapeLiteral(credentials.appPassword)}`,
    );
  } finally {
    await client.end();
  }

  provide('postgres', credentials);

  return async () => {
    await server.stop();
    // No Windows o processo do Postgres pode ainda segurar arquivos logo após o
    // stop (EBUSY). A limpeza tenta de novo e, se não conseguir, só avisa: um
    // diretório temporário esquecido não invalida testes que passaram.
    try {
      rmSync(databaseDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch (error) {
      console.warn(`Diretório temporário do Postgres não removido: ${databaseDir}`, error);
    }
  };
}
