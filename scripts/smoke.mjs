/**
 * Smoke test do que já está implementado, rodando contra os pacotes COMPILADOS
 * em `dist/` — não contra o source.
 *
 * Existe porque `npm test` valida o source via vitest, e build verde não prova
 * que o artefato emitido é utilizável. Este script importa o `dist` como um
 * consumidor real importaria.
 *
 * Uso: npm run smoke   (roda `npm run build` antes)
 */

import { fileURLToPath } from 'node:url';

const core = await import('../packages/core/dist/index.js');
const xsd = await import('../packages/xsd/dist/index.js');

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

console.log('\n— Chave de acesso ————————————————————————————');

const key = core.buildAccessKey({
  cUF: 35,
  issueDate: new Date('2026-09-11T10:00:00-03:00'),
  cnpj: alphaCnpj,
  model: 55,
  series: 1,
  number: 4242,
  tpEmis: 1,
  cNF: '87654321',
});

console.log(`        chave: ${key}`);
check('tem 44 posições', key.length, 44);
check('casa com TChNFe do XSD oficial', /^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$/.test(key), true);
check('DV confere', core.isValidAccessKey(key), true);

const parsed = core.parseAccessKey(key);
check('round-trip preserva CNPJ alfanumérico', parsed.cnpj, alphaCnpj);
check('round-trip preserva número', parsed.number, 4242);

// Fuso: 31/01 23h30 em Brasília não pode virar competência de fevereiro.
const borderKey = core.buildAccessKey({
  cUF: 35,
  issueDate: new Date('2026-01-31T23:30:00-03:00'),
  cnpj: '11222333000181',
  model: 55,
  series: 1,
  number: 1,
  tpEmis: 1,
  cNF: '00000001',
});
check('AAMM usa data local do emitente', borderKey.slice(2, 6), '2601');

console.log('\n— Precisão monetária —————————————————————————');

const { Decimal, allocate } = core;
check('0.1 + 0.2', Decimal.parse('0.1').plus(Decimal.parse('0.2')).toString(), '0.3');
check(
  '3.75 × 19.99',
  Decimal.parse('3.7500').times(Decimal.parse('19.9900')).toFixed(4),
  '74.9625',
);

const rateio = allocate(Decimal.parse('100.00'), [1, 1, 1], 2);
console.log(`        rateio 100,00 / 3: ${rateio.map((p) => p.toFixed(2)).join(' + ')}`);
check(
  'rateio fecha o total',
  rateio.reduce((a, b) => a.plus(b), Decimal.ZERO).toFixed(2),
  '100.00',
);

const comExcluido = allocate(Decimal.parse('0.05'), [0, 1, 1, 1], 2);
check('item de peso zero não recebe centavo', comExcluido[0].toFixed(2), '0.00');

console.log('\n— Máquina de estados ——————————————————————————');

const { NfeStatus, canReachTransmissionWithoutResolution, isEditable } = core;
check('autorizada não é editável', isEditable(NfeStatus.Authorized), false);
check(
  'reconciliação pendente não alcança transmissão',
  canReachTransmissionWithoutResolution(NfeStatus.PendingReconciliation),
  false,
);
check(
  'rascunho alcança transmissão',
  canReachTransmissionWithoutResolution(NfeStatus.Draft),
  true,
);

console.log('\n— Validação contra XSD oficial ————————————————');

const validator = new xsd.NfeSchemaValidator(repositoryRoot);
console.log(`        pacote: ${xsd.PL_010F.id} (${xsd.PL_010F.technicalNotes.join(', ')})`);

const invalidXml =
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<NFe xmlns="http://www.portalfiscal.inf.br/nfe">` +
  `<infNFe versao="4.00" Id="NFe123"><lixo/></infNFe></NFe>`;

const result = validator.validate(invalidXml);
check('XML fora do leiaute é rejeitado', result.valid, false);
check('erro foi traduzido para negócio', result.errors.length > 0, true);
if (result.errors[0]) {
  console.log(`        explicação: ${result.errors[0].explanation}`);
  console.log(`        ação: ${result.errors[0].suggestedAction}`);
}
validator.dispose();

console.log(
  `\n${failures === 0 ? 'SMOKE OK' : `SMOKE FALHOU — ${failures} verificação(ões)`}\n`,
);
process.exit(failures === 0 ? 0 : 1);
