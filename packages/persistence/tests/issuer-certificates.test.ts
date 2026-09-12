/**
 * Certificados A1 cifrados no Postgres: cadastro, troca, isolamento, recusas,
 * imutabilidade no banco e emissão assinada com o certificado cadastrado.
 */

import { randomBytes, X509Certificate } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { calculateCnpjCheckDigits, NfeStatus } from '@nfe/core';
import { CertificateError, createKeyring, parseMasterKey } from '@nfe/certificates';
import { EmissionService } from '@nfe/emission';
import { MockSefazProvider } from '@nfe/sefaz';
import { verifyNfeSignature } from '@nfe/signer';
import { NfeSchemaValidator } from '@nfe/xsd';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestPki } from '../../certificates/tests/support/test-pki.js';
import { makeDraft, schemaValidatorFor } from '../../emission/tests/support/fixtures.js';
import {
  CertificateAlreadyRegisteredError,
  IssuerCertificateRegistry,
  NoActiveCertificateError,
  PostgresEmissionStore,
} from '../src/index.js';
import { createScope, createTestDatabase, type TenantScope, type TestDatabase } from './support/database.js';

const CNPJ = '11222333000181';
const PASSPHRASE = 'senha-do-pfx-cadastrado';
const DAY = 24 * 60 * 60 * 1000;
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
const validator = new NfeSchemaValidator(repositoryRoot);
const key = parseMasterKey('chave-teste', randomBytes(32).toString('base64'));

let database: TestDatabase;
let registry: IssuerCertificateRegistry;
let pki: TestPki;

beforeAll(async () => {
  database = await createTestDatabase();
  registry = new IssuerCertificateRegistry({ db: database.db, keyring: createKeyring(key), sealingKey: key });
  pki = new TestPki();
});

afterAll(async () => {
  validator.dispose();
  await database.dispose();
});

function pfxFor(options: Parameters<TestPki['issue']>[0] = {}): Buffer {
  return pki.toPfx(pki.issue({ cnpj: CNPJ, clientAuth: true, ...options }), PASSPHRASE);
}

async function sqlState(operation: Promise<unknown>): Promise<string | undefined> {
  try {
    await operation;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

async function asTenant(scope: TenantScope, statement: string, params: unknown[]): Promise<void> {
  const client = await database.app.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    await client.query(statement, params);
    await client.query('ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

describe('cadastro de certificado', () => {
  it('guarda PFX e senha só cifrados, e reabre o certificado ativo', async () => {
    const scope = await createScope(database.db, 'cert-a');
    const pfx = pfxFor();

    const stored = await registry.register({ ...scope, pfx, passphrase: PASSPHRASE });
    expect(stored).toMatchObject({ issuerId: scope.issuerId, holderCnpj: CNPJ, active: true });

    const { rows } = await database.admin.query<{ sealed_pfx: string; sealed_passphrase: string }>(
      'SELECT sealed_pfx, sealed_passphrase FROM issuer_certificates WHERE id = $1',
      [stored.id],
    );
    const row = rows[0]!;
    expect(row.sealed_pfx.startsWith('nfev1.chave-teste.')).toBe(true);
    expect(row.sealed_passphrase).not.toContain(PASSPHRASE);
    expect(row.sealed_pfx).not.toContain(pfx.toString('base64'));
    expect(JSON.stringify(rows)).not.toContain(PASSPHRASE);

    const certificate = await registry.activeCertificate(scope.tenantId, scope.issuerId);
    expect(certificate.fingerprint256).toBe(stored.fingerprint256);
  });

  it('novo cadastro desativa o anterior; o mesmo certificado não é cadastrado duas vezes', async () => {
    const scope = await createScope(database.db, 'cert-b');
    const first = await registry.register({ ...scope, pfx: pfxFor(), passphrase: PASSPHRASE });
    const secondPfx = pfxFor();
    const second = await registry.register({ ...scope, pfx: secondPfx, passphrase: PASSPHRASE });

    const listed = await registry.list(scope.tenantId, scope.issuerId);
    expect(listed.map((certificate) => [certificate.id, certificate.active])).toEqual([
      [second.id, true],
      [first.id, false],
    ]);
    expect((await registry.activeCertificate(scope.tenantId, scope.issuerId)).fingerprint256).toBe(
      second.fingerprint256,
    );
    await expect(registry.register({ ...scope, pfx: secondPfx, passphrase: PASSPHRASE })).rejects.toBeInstanceOf(
      CertificateAlreadyRegisteredError,
    );
  });

  it('recusa certificado de outra empresa, vencido ou sem autenticação de cliente, sem gravar nada', async () => {
    const scope = await createScope(database.db, 'cert-c');
    const otherCompany = `998877660001${calculateCnpjCheckDigits('998877660001')}`;

    const reasons = [];
    for (const pfx of [
      pfxFor({ cnpj: otherCompany }),
      pfxFor({ notBefore: new Date(Date.now() - 400 * DAY), notAfter: new Date(Date.now() - DAY) }),
      pfxFor({ clientAuth: false, serverAuth: true }),
    ]) {
      try {
        await registry.register({ ...scope, pfx, passphrase: PASSPHRASE });
      } catch (error) {
        reasons.push((error as CertificateError).reason);
      }
    }

    expect(reasons).toEqual(['CNPJ_MISMATCH', 'EXPIRED', 'MISSING_CLIENT_AUTHENTICATION']);
    expect(await registry.list(scope.tenantId, scope.issuerId)).toEqual([]);
  });

  it('outro tenant não enxerga nem usa o certificado', async () => {
    const owner = await createScope(database.db, 'cert-d');
    const stranger = await createScope(database.db, 'cert-e');
    await registry.register({ ...owner, pfx: pfxFor(), passphrase: PASSPHRASE });

    expect(await registry.list(stranger.tenantId, owner.issuerId)).toEqual([]);
    await expect(registry.activeCertificate(stranger.tenantId, owner.issuerId)).rejects.toBeInstanceOf(
      NoActiveCertificateError,
    );
  });
});

describe('imutabilidade no banco', () => {
  it('segredo não é trocado, cadastro não é excluído e desativado não volta a ativo', async () => {
    const scope = await createScope(database.db, 'cert-f');
    const first = await registry.register({ ...scope, pfx: pfxFor(), passphrase: PASSPHRASE });
    await registry.register({ ...scope, pfx: pfxFor(), passphrase: PASSPHRASE });

    expect(
      await sqlState(
        asTenant(scope, "UPDATE issuer_certificates SET sealed_passphrase = 'nfev1.x' WHERE id = $1", [first.id]),
      ),
    ).toBe('NFE08');
    expect(
      await sqlState(
        asTenant(scope, 'UPDATE issuer_certificates SET active = true, deactivated_at = NULL WHERE id = $1', [first.id]),
      ),
    ).toBe('NFE08');
    expect(await sqlState(asTenant(scope, 'DELETE FROM issuer_certificates WHERE id = $1', [first.id]))).toBe('42501');
    expect(await sqlState(database.admin.query('DELETE FROM issuer_certificates WHERE id = $1', [first.id]))).toBe(
      'NFE08',
    );
  });
});

describe('emissão com o certificado cadastrado', () => {
  it('assina a NF-e com o certificado ativo do emitente', async () => {
    const scope = await createScope(database.db, 'cert-g');
    const stored = await registry.register({ ...scope, pfx: pfxFor(), passphrase: PASSPHRASE });
    const service = new EmissionService({
      store: new PostgresEmissionStore(database.db),
      sefaz: new MockSefazProvider(),
      signer: registry.signer(),
      schemaValidator: schemaValidatorFor(validator),
    });

    const { invoice } = await service.createDraft({ ...scope, idempotencyKey: 'com-certificado', draft: makeDraft() });
    const issued = await service.issue({ tenantId: scope.tenantId, invoiceId: invoice.id });

    expect(issued.kind).toBe('QUEUED');
    const verification = verifyNfeSignature(issued.invoice.signedXml!);
    expect(verification.valid).toBe(true);
    if (verification.valid) {
      expect(new X509Certificate(verification.certificate.raw).fingerprint256).toBe(stored.fingerprint256);
    }
  });

  it('emitente sem certificado para em validação local sem consumir número', async () => {
    const scope = await createScope(database.db, 'cert-h');
    const service = new EmissionService({
      store: new PostgresEmissionStore(database.db),
      sefaz: new MockSefazProvider(),
      signer: registry.signer(),
      schemaValidator: schemaValidatorFor(validator),
    });

    const { invoice } = await service.createDraft({ ...scope, idempotencyKey: 'sem-certificado', draft: makeDraft() });
    const issued = await service.issue({ tenantId: scope.tenantId, invoiceId: invoice.id });

    expect(issued.kind).toBe('LOCAL_VALIDATION_ERROR');
    expect(issued.invoice.status).toBe(NfeStatus.LocalValidationError);
    expect(issued.invoice.number).toBeUndefined();
  });
});
