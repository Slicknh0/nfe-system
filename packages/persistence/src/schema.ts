/**
 * Mapeamento Drizzle das tabelas criadas pelas migrations SQL.
 *
 * As migrations em `migrations/` são a fonte da verdade: constraints, triggers
 * e RLS vivem lá, revisáveis como SQL. Este arquivo existe para consultas
 * tipadas, e um teste compara suas colunas com o `information_schema` para
 * impedir que os dois divirjam.
 */

import type { EncodedValue } from '@nfe/emission';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
});

export const issuers = pgTable('issuers', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  cnpj: char('cnpj', { length: 14 }).notNull(),
  legalName: text('legal_name').notNull(),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
});

export const numberSequences = pgTable(
  'number_sequences',
  {
    tenantId: uuid('tenant_id').notNull(),
    issuerId: uuid('issuer_id').notNull(),
    environment: smallint('environment').notNull(),
    model: smallint('model').notNull(),
    series: integer('series').notNull(),
    nextNumber: integer('next_number').notNull().default(1),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.issuerId, table.environment, table.model, table.series] }),
  ],
);

export const invoices = pgTable('invoices', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  issuerId: uuid('issuer_id').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  requestHash: char('request_hash', { length: 64 }).notNull(),
  environment: smallint('environment').notNull(),
  model: smallint('model').notNull().default(55),
  series: integer('series').notNull(),
  status: text('status').notNull(),
  version: integer('version').notNull().default(1),
  draft: jsonb('draft').$type<EncodedValue>().notNull(),
  number: integer('number'),
  accessKey: char('access_key', { length: 44 }),
  signedXml: text('signed_xml'),
  protocolNumber: varchar('protocol_number', { length: 17 }),
  protocolStatusCode: integer('protocol_status_code'),
  protocolStatusReason: text('protocol_status_reason'),
  protocolReceivedAt: timestamptz('protocol_received_at'),
  protocolDigestValue: text('protocol_digest_value'),
  protocolXml: text('protocol_xml'),
  lastStatusCode: integer('last_status_code'),
  lastStatusReason: text('last_status_reason'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

export const invoiceStatusHistory = pgTable('invoice_status_history', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  tenantId: uuid('tenant_id').notNull(),
  invoiceId: uuid('invoice_id').notNull(),
  fromStatus: text('from_status'),
  toStatus: text('to_status').notNull(),
  reason: text('reason'),
  occurredAt: timestamptz('occurred_at').notNull().defaultNow(),
});

export const numberVoids = pgTable('number_voids', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  invoiceId: uuid('invoice_id').notNull(),
  environment: smallint('environment').notNull(),
  model: smallint('model').notNull().default(55),
  series: integer('series').notNull(),
  firstNumber: integer('first_number').notNull(),
  lastNumber: integer('last_number').notNull(),
  year: smallint('year').notNull(),
  justification: text('justification').notNull(),
  requestId: char('request_id', { length: 43 }).notNull(),
  signedXml: text('signed_xml').notNull(),
  status: text('status').notNull(),
  protocolNumber: varchar('protocol_number', { length: 17 }),
  protocolStatusCode: integer('protocol_status_code'),
  protocolStatusReason: text('protocol_status_reason'),
  protocolReceivedAt: timestamptz('protocol_received_at'),
  responseXml: text('response_xml'),
  lastStatusCode: integer('last_status_code'),
  lastStatusReason: text('last_status_reason'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

export const sefazAttempts = pgTable('sefaz_attempts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  invoiceId: uuid('invoice_id').notNull(),
  operation: text('operation').notNull(),
  startedAt: timestamptz('started_at').notNull().default(sql`clock_timestamp()`),
  finishedAt: timestamptz('finished_at'),
  outcome: text('outcome'),
  statusCode: integer('status_code'),
  statusReason: text('status_reason'),
  detail: text('detail'),
});

export const issuerCertificates = pgTable('issuer_certificates', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  issuerId: uuid('issuer_id').notNull(),
  fingerprintSha256: char('fingerprint_sha256', { length: 95 }).notNull(),
  subject: text('subject').notNull(),
  holderCnpj: char('holder_cnpj', { length: 14 }).notNull(),
  notBefore: timestamptz('not_before').notNull(),
  notAfter: timestamptz('not_after').notNull(),
  sealedPfx: text('sealed_pfx').notNull(),
  sealedPassphrase: text('sealed_passphrase').notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  deactivatedAt: timestamptz('deactivated_at'),
});
