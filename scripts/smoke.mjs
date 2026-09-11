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

import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import forge from 'node-forge';

const core = await import('../packages/core/dist/index.js');
const xsd = await import('../packages/xsd/dist/index.js');
const signer = await import('../packages/signer/dist/index.js');

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
validator.dispose();

console.log(
  `\n${failures === 0 ? 'SMOKE OK' : `SMOKE FALHOU — ${failures} verificação(ões)`}\n`,
);
process.exit(failures === 0 ? 0 : 1);
