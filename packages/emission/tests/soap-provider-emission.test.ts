/**
 * Serviço de emissão com o provider SOAP real, falando HTTPS com autenticação
 * mútua contra uma SEFAZ local. Prova que o encadeamento completo — XML
 * assinado, envelope, TLS, leitura do retorno, estados e reconciliação —
 * funciona com o transporte de verdade, e não só com o mock.
 */

import { fileURLToPath } from 'node:url';
import { NfeStatus } from '@nfe/core';
import { HttpsSoapTransport, SoapSefazProvider } from '@nfe/sefaz';
import { NfeSchemaValidator } from '@nfe/xsd';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestPki } from '../../certificates/tests/support/test-pki.js';
import {
  FakeSefaz,
  neverRespond,
  soapResultFrom,
  type RecordedRequest,
} from '../../sefaz/tests/soap/support/fake-sefaz.js';
import { retConsSitNFe, retEnviNFe } from '../../sefaz/tests/soap/support/sefaz-responses.js';
import { EmissionService, type InvoiceReference } from '../src/index.js';
import { makeDraft, schemaValidatorFor, testSigner } from './support/fixtures.js';
import { InMemoryEmissionStore } from './support/in-memory-store.js';

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
const validator = new NfeSchemaValidator(repositoryRoot);
const scope = { tenantId: 'tenant-a', issuerId: 'issuer-a' };

let sefaz: FakeSefaz;
let service: EmissionService;
let store: InMemoryEmissionStore;
let sequence = 0;

function keyFromAuthorization(request: RecordedRequest): string {
  const key = /Id="NFe([0-9A-Z]{44})"/.exec(request.body)?.[1];
  if (key === undefined) {
    throw new Error('Requisição de autorização sem chave.');
  }
  return key;
}

function keyFromQuery(request: RecordedRequest): string {
  const key = /<chNFe>([0-9A-Z]{44})<\/chNFe>/.exec(request.body)?.[1];
  if (key === undefined) {
    throw new Error('Consulta sem chave.');
  }
  return key;
}

beforeAll(async () => {
  const pki = new TestPki('AC Raiz SEFAZ de teste');
  const server = pki.issue({ commonName: 'localhost', dnsNames: ['localhost'], serverAuth: true });
  const client = pki.issue({ commonName: 'TRANSMISSOR DE TESTE', cnpj: '11222333000181', clientAuth: true });
  sefaz = await FakeSefaz.start({ serverCertificate: server, trustedClientRootsPem: [pki.root.certificatePem] });

  store = new InMemoryEmissionStore();
  service = new EmissionService({
    store,
    signer: testSigner(),
    schemaValidator: schemaValidatorFor(validator),
    sefaz: new SoapSefazProvider({
      environment: 2,
      endpoints: sefaz.endpoints(),
      transport: new HttpsSoapTransport({
        credentials: { privateKeyPem: client.privateKeyPem, certificatePem: client.certificatePem },
        trustedCertificatesPem: [pki.root.certificatePem],
        responseTimeoutMs: 1500,
      }),
    }),
  });
}, 60_000);

afterAll(async () => {
  validator.dispose();
  await sefaz.close();
});

async function queued(): Promise<InvoiceReference> {
  sequence += 1;
  const { invoice } = await service.createDraft({ ...scope, idempotencyKey: `soap-${sequence}`, draft: makeDraft() });
  const reference = { tenantId: scope.tenantId, invoiceId: invoice.id };
  expect((await service.issue(reference)).kind).toBe('QUEUED');
  return reference;
}

describe('emissão pelo provider SOAP', () => {
  it('autoriza e guarda o protocolo com o XML devolvido pela SEFAZ', async () => {
    const reference = await queued();
    sefaz.respondWith(
      soapResultFrom((request) =>
        retEnviNFe({
          statusCode: 104,
          statusReason: 'Lote processado',
          protocol: {
            accessKey: keyFromAuthorization(request),
            statusCode: 100,
            statusReason: 'Autorizado o uso da NF-e',
            protocolNumber: '135260000000501',
          },
        }),
      ),
    );

    const outcome = await service.transmit(reference);

    expect(outcome.outcome).toBe('AUTHORIZED');
    expect(outcome.invoice.status).toBe(NfeStatus.Authorized);
    expect(outcome.invoice.protocol?.protocolNumber).toBe('135260000000501');
    expect(outcome.invoice.protocol?.xml).toContain('<protNFe');
    expect(sefaz.requests.at(-1)?.clientCommonName).toBe('TRANSMISSOR DE TESTE');
  });

  it('timeout na transmissão vira reconciliação, resolvida por consulta SOAP sem reenviar', async () => {
    const reference = await queued();
    const before = sefaz.requests.length;
    sefaz.respondWith(neverRespond());

    const lost = await service.transmit(reference);
    expect(lost).toMatchObject({ outcome: 'NO_RESPONSE', invoice: { status: NfeStatus.PendingReconciliation } });

    sefaz.respondWith(
      soapResultFrom((request) => {
        const accessKey = keyFromQuery(request);
        return retConsSitNFe({
          statusCode: 100,
          statusReason: 'Autorizado o uso da NF-e',
          accessKey,
          protocol: { accessKey, statusCode: 100, statusReason: 'Autorizado o uso da NF-e', protocolNumber: '135260000000502' },
        });
      }, 'NFeConsultaProtocolo4'),
    );

    expect(await service.reconcile(reference)).toMatchObject({ outcome: 'AUTHORIZED', resolved: true });
    expect(sefaz.requests.slice(before).map((request) => request.path)).toEqual([
      '/ws/nfeautorizacao4.asmx',
      '/ws/nfeconsultaprotocolo4.asmx',
    ]);
  });
});
