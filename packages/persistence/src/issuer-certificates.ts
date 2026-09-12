/**
 * Certificados A1 dos emitentes, guardados cifrados no Postgres.
 *
 * - O PFX e a senha são selados com a chave mestra antes de chegar ao banco;
 *   o banco só vê o texto cifrado.
 * - O certificado é aberto e conferido no cadastro: senha errada, vencido, sem
 *   CNPJ, de outra empresa ou sem "Autenticação Cliente" é recusado ali, e não
 *   na primeira emissão.
 * - Trocar de certificado é cadastrar outro: o anterior é desativado na mesma
 *   transação, e o registro desativado nunca volta a ser ativo (trigger NFE08).
 */

import {
  CertificateError,
  assertCertificateUsable,
  openCertificate,
  sealCertificate,
  type A1Certificate,
  type Keyring,
  type MasterKey,
} from '@nfe/certificates';
import { SigningRefusedError, type XmlSigner } from '@nfe/emission';
import { XmlSignatureError, signInutilizationXml, signNfeXml } from '@nfe/signer';
import { and, desc, eq, sql } from 'drizzle-orm';
import { isUuid, withTenant, type Database, type Transaction } from './database.js';
import { translateDatabaseError } from './errors.js';
import { issuerCertificates, issuers } from './schema.js';

export class IssuerNotFoundError extends Error {
  constructor(readonly issuerId: string) {
    super(`Emitente ${issuerId} não encontrado.`);
    this.name = 'IssuerNotFoundError';
  }
}

export class NoActiveCertificateError extends Error {
  constructor(readonly issuerId: string) {
    super(`O emitente ${issuerId} não tem certificado ativo cadastrado.`);
    this.name = 'NoActiveCertificateError';
  }
}

export class CertificateAlreadyRegisteredError extends Error {
  constructor() {
    super('Este certificado já foi cadastrado para o emitente.');
    this.name = 'CertificateAlreadyRegisteredError';
  }
}

export interface StoredCertificate {
  readonly id: string;
  readonly issuerId: string;
  readonly fingerprint256: string;
  readonly subject: string;
  readonly holderCnpj: string;
  readonly notBefore: Date;
  readonly notAfter: Date;
  readonly active: boolean;
  readonly createdAt: Date;
  readonly deactivatedAt?: Date;
}

export interface CertificateRegistration {
  readonly tenantId: string;
  readonly issuerId: string;
  readonly pfx: Uint8Array;
  readonly passphrase: string;
  readonly now?: Date;
}

export interface IssuerCertificateRegistryOptions {
  readonly db: Database;
  /** Todas as chaves mestras que ainda abrem segredos guardados. */
  readonly keyring: Keyring;
  /** Chave usada para selar novos cadastros. Precisa estar no chaveiro. */
  readonly sealingKey: MasterKey;
}

type CertificateRow = typeof issuerCertificates.$inferSelect;

function toStored(row: CertificateRow): StoredCertificate {
  return {
    id: row.id,
    issuerId: row.issuerId,
    fingerprint256: row.fingerprintSha256,
    subject: row.subject,
    holderCnpj: row.holderCnpj,
    notBefore: row.notBefore,
    notAfter: row.notAfter,
    active: row.active,
    createdAt: row.createdAt,
    ...(row.deactivatedAt === null ? {} : { deactivatedAt: row.deactivatedAt }),
  };
}

export class IssuerCertificateRegistry {
  private readonly db: Database;
  private readonly keyring: Keyring;
  private readonly sealingKey: MasterKey;

  constructor(options: IssuerCertificateRegistryOptions) {
    if (options.keyring.get(options.sealingKey.id) !== options.sealingKey) {
      throw new Error('A chave de selagem precisa estar no chaveiro.');
    }
    this.db = options.db;
    this.keyring = options.keyring;
    this.sealingKey = options.sealingKey;
  }

  async register(input: CertificateRegistration): Promise<StoredCertificate> {
    const now = input.now ?? new Date();
    const owner = { tenantId: input.tenantId, issuerId: input.issuerId };
    const issuerCnpj = await this.issuerCnpj(input.tenantId, input.issuerId);

    const { sealed, certificate } = sealCertificate(input.pfx, input.passphrase, owner, this.sealingKey);
    assertCertificateUsable(certificate, { purpose: 'SIGNING', issuerCnpj, now });
    assertCertificateUsable(certificate, { purpose: 'TRANSMISSION', now });
    const holderCnpj = certificate.cnpj;
    if (holderCnpj === undefined) {
      throw new CertificateError('MISSING_CNPJ', 'O certificado não traz CNPJ.');
    }

    return await this.inTenant(input.tenantId, async (tx) => {
      const [duplicate] = await tx
        .select({ id: issuerCertificates.id })
        .from(issuerCertificates)
        .where(
          and(
            eq(issuerCertificates.issuerId, input.issuerId),
            eq(issuerCertificates.fingerprintSha256, certificate.fingerprint256),
          ),
        );
      if (duplicate !== undefined) {
        throw new CertificateAlreadyRegisteredError();
      }

      await tx
        .update(issuerCertificates)
        .set({ active: false, deactivatedAt: sql`now()` })
        .where(
          and(
            eq(issuerCertificates.tenantId, input.tenantId),
            eq(issuerCertificates.issuerId, input.issuerId),
            eq(issuerCertificates.active, true),
          ),
        );

      const [row] = await tx
        .insert(issuerCertificates)
        .values({
          tenantId: input.tenantId,
          issuerId: input.issuerId,
          fingerprintSha256: certificate.fingerprint256,
          subject: certificate.subject,
          holderCnpj,
          notBefore: certificate.notBefore,
          notAfter: certificate.notAfter,
          sealedPfx: sealed.sealedPfx,
          sealedPassphrase: sealed.sealedPassphrase,
        })
        .returning();
      if (row === undefined) {
        throw new Error('O certificado não foi gravado.');
      }
      return toStored(row);
    });
  }

  /** Abre o certificado ativo em memória e confere a validade no instante informado. */
  async activeCertificate(tenantId: string, issuerId: string, now: Date = new Date()): Promise<A1Certificate> {
    if (!isUuid(tenantId) || !isUuid(issuerId)) {
      throw new NoActiveCertificateError(issuerId);
    }
    const [row] = await this.inTenant(tenantId, (tx) =>
      tx
        .select()
        .from(issuerCertificates)
        .where(
          and(
            eq(issuerCertificates.tenantId, tenantId),
            eq(issuerCertificates.issuerId, issuerId),
            eq(issuerCertificates.active, true),
          ),
        )
        .then((rows) => rows),
    );
    if (row === undefined) {
      throw new NoActiveCertificateError(issuerId);
    }
    const certificate = openCertificate(
      { sealedPfx: row.sealedPfx, sealedPassphrase: row.sealedPassphrase },
      { tenantId, issuerId },
      this.keyring,
    );
    assertCertificateUsable(certificate, { purpose: 'SIGNING', now });
    return certificate;
  }

  async list(tenantId: string, issuerId: string): Promise<readonly StoredCertificate[]> {
    if (!isUuid(tenantId) || !isUuid(issuerId)) {
      return [];
    }
    const rows = await this.inTenant(tenantId, (tx) =>
      tx
        .select()
        .from(issuerCertificates)
        .where(and(eq(issuerCertificates.tenantId, tenantId), eq(issuerCertificates.issuerId, issuerId)))
        .orderBy(desc(issuerCertificates.createdAt), desc(issuerCertificates.id))
        .then((result) => result),
    );
    return rows.map(toStored);
  }

  /**
   * Assinador da aplicação apoiado no certificado ativo de cada emitente.
   * Ausência de certificado, vencimento ou chave divergente viram
   * `SigningRefusedError`: a emissão para em validação local, sem consumir número.
   */
  signer(): XmlSigner {
    return {
      sign: async ({ tenantId, issuerId, document, unsignedXml, now }) => {
        let certificate: A1Certificate;
        try {
          certificate = await this.activeCertificate(tenantId, issuerId, now);
        } catch (error) {
          if (error instanceof NoActiveCertificateError) {
            throw new SigningRefusedError('NO_ACTIVE_CERTIFICATE', error.message);
          }
          if (error instanceof CertificateError) {
            throw new SigningRefusedError(error.reason, error.message);
          }
          throw error;
        }
        try {
          const sign = document === 'NFE' ? signNfeXml : signInutilizationXml;
          return sign(unsignedXml, certificate, { now });
        } catch (error) {
          if (error instanceof XmlSignatureError) {
            throw new SigningRefusedError(error.reason, error.message);
          }
          throw error;
        }
      },
    };
  }

  private async issuerCnpj(tenantId: string, issuerId: string): Promise<string> {
    if (!isUuid(tenantId) || !isUuid(issuerId)) {
      throw new IssuerNotFoundError(issuerId);
    }
    const [row] = await this.inTenant(tenantId, (tx) =>
      tx
        .select({ cnpj: issuers.cnpj })
        .from(issuers)
        .where(and(eq(issuers.id, issuerId), eq(issuers.tenantId, tenantId)))
        .then((rows) => rows),
    );
    if (row === undefined) {
      throw new IssuerNotFoundError(issuerId);
    }
    return row.cnpj;
  }

  private async inTenant<T>(tenantId: string, work: (tx: Transaction) => Promise<T>): Promise<T> {
    try {
      return await withTenant(this.db, tenantId, work);
    } catch (error) {
      throw translateDatabaseError(error);
    }
  }
}
