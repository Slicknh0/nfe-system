/**
 * Smoke test do que já está implementado, rodando contra os pacotes COMPILADOS
 * em `dist/` — não contra o source.
 *
 * Existe porque `npm test` valida o source via vitest, e build verde não prova
 * que o artefato emitido é utilizável. Este script importa o `dist` como um
 * consumidor real importaria e percorre o pipeline inteiro: montar o XML,
 * assinar, validar contra o XSD oficial e verificar a assinatura.
 *
 * Uso: npm run smoke   (roda `npm run build` antes)
 */

import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import forge from 'node-forge';
import pg from 'pg';

const core = await import('../packages/core/dist/index.js');
const xsd = await import('../packages/xsd/dist/index.js');
const signer = await import('../packages/signer/dist/index.js');
const sefaz = await import('../packages/sefaz/dist/index.js');
const emission = await import('../packages/emission/dist/index.js');
const persistence = await import('../packages/persistence/dist/index.js');

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

let failures = 0;
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? 'OK  ' : 'FALHA'}  ${label}`);
  if (!ok) console.log(`        esperado ${expected}, obtido ${actual}`);
};

console.log('\n— CNPJ alfanumérico (NT 2026.004) ———————————————');

check('CNPJ numérico conhecido é válido', core.isValidCnpj('11222333000181'), true);
check('DV do CNPJ conhecido', core.calculateCnpjCheckDigits('112223330001'), '81');

const alphaBase = 'A1B2C3D4E5F6';
const alphaCnpj = alphaBase + core.calculateCnpjCheckDigits(alphaBase);
check(`CNPJ alfanumérico ${alphaCnpj} é válido`, core.isValidCnpj(alphaCnpj), true);
check('adulteração é detectada', core.isValidCnpj('B' + alphaCnpj.slice(1)), false);

console.log('\n— Precisão monetária —————————————————————————');

const { Decimal, allocate } = core;
check('0.1 + 0.2', Decimal.parse('0.1').plus(Decimal.parse('0.2')).toString(), '0.3');

const rateio = allocate(Decimal.parse('100.00'), [1, 1, 1], 2);
console.log(`        rateio 100,00 / 3: ${rateio.map((p) => p.toFixed(2)).join(' + ')}`);
check(
  'rateio fecha o total',
  rateio.reduce((a, b) => a.plus(b), Decimal.ZERO).toFixed(2),
  '100.00',
);

console.log('\n— Máquina de estados ——————————————————————————');

const { NfeStatus, canReachTransmissionWithoutResolution, isEditable } = core;
check('autorizada não é editável', isEditable(NfeStatus.Authorized), false);
check(
  'reconciliação pendente não alcança transmissão',
  canReachTransmissionWithoutResolution(NfeStatus.PendingReconciliation),
  false,
);

console.log('\n— Pipeline: montar → assinar → XSD oficial → verificar ——');

const address = {
  street: 'Avenida Paulista',
  number: '1000',
  district: 'Bela Vista',
  municipalityCode: '3550308',
  municipalityName: 'São Paulo',
  state: 'SP',
  postalCode: '01310100',
};

const document = {
  identification: {
    stateCode: 35,
    randomCode: '48213967',
    operationNature: 'Venda de mercadoria',
    series: 1,
    number: 4242,
    issuedAt: new Date('2026-09-11T10:00:00-03:00'),
    timeZone: 'America/Sao_Paulo',
    operationType: core.OperationType.Exit,
    destinationScope: core.DestinationScope.Internal,
    municipalityCode: '3550308',
    printFormat: core.DanfePrintFormat.Portrait,
    emissionType: core.EmissionType.Normal,
    environment: core.Environment.Homologation,
    purpose: core.InvoicePurpose.Normal,
    finalConsumer: core.FinalConsumer.Yes,
    buyerPresence: core.BuyerPresence.InPerson,
    applicationVersion: 'nfe-system 0.1.0',
  },
  issuer: {
    cnpj: alphaCnpj,
    legalName: 'Loja Exemplo Comercio de Roupas Ltda',
    address,
    stateRegistration: '123456789012',
    taxRegime: core.TaxRegime.SimplesNacional,
  },
  recipient: {
    document: { type: 'CPF', value: '52998224725' },
    name: 'Maria da Silva',
    address: { ...address, street: 'Rua Augusta', number: '500', postalCode: '01305000' },
    stateRegistrationIndicator: core.StateRegistrationIndicator.NonContributor,
  },
  items: [
    {
      productCode: 'CAM-001',
      description: 'Camiseta de algodão',
      ncm: '61091000',
      cfop: '5102',
      unit: 'UN',
      quantity: Decimal.parse('2'),
      unitPrice: Decimal.parse('49.90'),
      taxes: {
        icms: { kind: 'SimplesNacional102', origin: 0, csosn: '102' },
        pis: { kind: 'NonTaxed', cst: '07' },
        cofins: { kind: 'NonTaxed', cst: '07' },
      },
    },
  ],
  transport: { freightMode: core.FreightMode.NoFreight },
  payment: {
    entries: [
      { indicator: core.PaymentIndicator.Immediate, method: '01', amount: Decimal.parse('99.80') },
    ],
  },
};

const unsigned = core.buildUnsignedNfe(document);
console.log(`        chave: ${unsigned.accessKey}`);
check('chave com CNPJ alfanumérico é válida', core.isValidAccessKey(unsigned.accessKey), true);
check('vNF derivado dos itens', unsigned.totals.invoice.toFixed(2), '99.80');

// Certificado autoassinado gerado em memória — nenhuma credencial real envolvida.
const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});
const certificate = forge.pki.createCertificate();
certificate.publicKey = forge.pki.publicKeyFromPem(keys.publicKey);
certificate.serialNumber = '01';
certificate.validity.notBefore = new Date(Date.now() - 86_400_000);
certificate.validity.notAfter = new Date(Date.now() + 86_400_000);
const subject = [{ name: 'commonName', value: 'SMOKE TEST' }];
certificate.setSubject(subject);
certificate.setIssuer(subject);
certificate.sign(forge.pki.privateKeyFromPem(keys.privateKey), forge.md.sha256.create());
const credentials = {
  privateKeyPem: keys.privateKey,
  certificatePem: forge.pki.certificateToPem(certificate),
};

const validator = new xsd.NfeSchemaValidator(repositoryRoot);
console.log(`        schema: ${xsd.PL_010F.id} (${xsd.PL_010F.technicalNotes.join(', ')})`);

const unsignedResult = validator.validate(unsigned.xml);
check('XML sem assinatura é rejeitado (ds:Signature obrigatória)', unsignedResult.valid, false);

const signed = signer.signNfeXml(unsigned.xml, credentials);
const signedResult = validator.validate(signed);
check('XML assinado passa no XSD oficial', signedResult.valid, true);
for (const error of signedResult.errors) {
  console.log(`        ${error.technicalMessage}`);
}

check('assinatura confere', signer.verifyNfeSignature(signed).valid, true);

const tampered = signed.replace('<vNF>99.80</vNF>', '<vNF>9.80</vNF>');
check('valor alterado após assinar é detectado', signer.verifyNfeSignature(tampered).valid, false);

console.log(`        XML assinado: ${signed.length} bytes`);

console.log('\n— Emissão: Postgres real, RLS e SEFAZ simulada ————————');

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// Postgres descartável: diretório temporário, porta livre, senhas geradas agora.
const databaseDir = mkdtempSync(join(tmpdir(), 'nfe-smoke-'));
const port = await freePort();
const adminPassword = randomBytes(24).toString('base64url');
const appPassword = randomBytes(24).toString('base64url');
const server = new EmbeddedPostgres({
  databaseDir,
  port,
  user: 'postgres',
  password: adminPassword,
  persistent: false,
  onLog: () => undefined,
});

try {
  await server.initialise();
  await server.start();
  const connection = { host: '127.0.0.1', port, database: 'postgres' };
  const admin = new pg.Pool({ ...connection, user: 'postgres', password: adminPassword, max: 2 });
  await admin.query(
    `CREATE ROLE nfe_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${pg.escapeLiteral(appPassword)}`,
  );

  const applied = await persistence.migrate(admin);
  check('migrations aplicadas', applied.length, persistence.loadMigrations().length);
  await persistence.grantApplicationAccess(admin, 'nfe_app');

  const app = new pg.Pool({ ...connection, user: 'nfe_app', password: appPassword, max: 8 });
  await persistence.assertRestrictedRole(app);
  check('aplicação conecta com papel sem superusuário e sem BYPASSRLS', true, true);

  const db = persistence.createDatabase(app);
  const tenantId = await persistence.createTenant(db, 'Smoke');
  const issuerId = await persistence.createIssuer(db, tenantId, {
    cnpj: alphaCnpj,
    legalName: 'Loja Exemplo Comercio de Roupas Ltda',
  });

  const store = new persistence.PostgresEmissionStore(db);
  const mock = new sefaz.MockSefazProvider().scriptAuthorizations({
    type: 'lose-response-after-processing',
  });
  const service = new emission.EmissionService({
    store,
    sefaz: mock,
    signer: {
      sign: ({ document, unsignedXml, now }) =>
        Promise.resolve(
          (document === 'NFE' ? signer.signNfeXml : signer.signInutilizationXml)(unsignedXml, credentials, {
            now,
          }),
        ),
    },
    schemaValidator: {
      validate: (xml, document) =>
        validator.validate(xml, document === 'NFE' ? xsd.PL_010F : xsd.PL_010D_INUTILIZATION),
    },
    // Sem espera entre consultas: o smoke verifica o encadeamento, não o relógio.
    reconciliationPolicy: {
      firstQueryDelayMs: 0,
      queryIntervalsMs: [0],
      notFoundQueriesBeforeVoid: 3,
      minimumAgeBeforeVoidMs: 0,
    },
  });

  const { number: _number, randomCode: _randomCode, issuedAt: _issuedAt, ...draftIdentification } =
    document.identification;
  const draft = { ...document, identification: draftIdentification };
  const { invoice } = await service.createDraft({
    tenantId,
    issuerId,
    idempotencyKey: 'smoke-1',
    draft,
  });
  const reference = { tenantId, invoiceId: invoice.id };

  const issued = await service.issue(reference);
  check('rascunho emitido com o número 1 da série', `${issued.kind} ${issued.invoice.number}`, 'QUEUED 1');

  const sent = await service.transmit(reference);
  check('resposta perdida vira reconciliação pendente', sent.invoice.status, 'PENDING_RECONCILIATION');

  const reconciled = await service.reconcile(reference);
  check('consulta à SEFAZ resolve como autorizada', reconciled.invoice.status, 'AUTHORIZED');
  check('a SEFAZ recebeu um único envio', mock.countCalls('AUTHORIZATION'), 1);

  let sqlState = 'nenhum';
  const client = await app.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await client.query("UPDATE invoices SET status = 'DRAFT' WHERE id = $1", [invoice.id]);
  } catch (error) {
    sqlState = error.code;
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  check('o banco recusa reabrir NF-e autorizada, mesmo com SQL direto', sqlState, 'NFE02');

  console.log('\n— Inutilização: nota que nunca chegou à SEFAZ ———————————');

  mock.scriptAuthorizations({ type: 'lose-request' });
  const { invoice: lostInvoice } = await service.createDraft({
    tenantId,
    issuerId,
    idempotencyKey: 'smoke-2',
    draft,
  });
  const lost = { tenantId, invoiceId: lostInvoice.id };
  await service.issue(lost);
  await service.transmit(lost);
  const queries = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    queries.push((await service.reconcile(lost)).outcome);
  }
  check('três consultas devolvem 217', queries.join(','), 'NOT_FOUND,NOT_FOUND,NOT_FOUND');

  const voided = await service.voidNumber({
    ...lost,
    justification: 'NF-e pendente de retorno nao localizada na SEFAZ apos consultas',
  });
  check('numeração inutilizada na SEFAZ', voided.invoice.status, 'NUMBER_VOIDED');

  const voidRecord = await store.findNumberVoid(tenantId, lostInvoice.id);
  check('protocolo de inutilização gravado', voidRecord?.protocol?.statusCode, 102);
  check(
    'pedido de inutilização assinado passa no XSD oficial (PL_010d)',
    validator.validate(voidRecord.signedXml, xsd.PL_010D_INUTILIZATION).valid,
    true,
  );
  check('assinatura do pedido de inutilização confere', signer.verifyInutilizationSignature(voidRecord.signedXml).valid, true);

  await app.end();
  await admin.end();
} finally {
  await server.stop();
  // No Windows o Postgres pode ainda segurar arquivos logo após o stop (EBUSY).
  try {
    rmSync(databaseDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    console.warn(`        diretório temporário não removido: ${databaseDir}`);
  }
}

validator.dispose();

console.log(
  `\n${failures === 0 ? 'SMOKE OK' : `SMOKE FALHOU — ${failures} verificação(ões)`}\n`,
);
process.exit(failures === 0 ? 0 : 1);
