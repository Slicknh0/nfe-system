/**
 * Credenciais autoassinadas geradas em memória para teste.
 *
 * Nenhum certificado real ou chave persistida entra no repositório. O par de
 * chaves é gerado por `node:crypto` (nativo, rápido) e o certificado X.509 por
 * `node-forge`, que o Node não produz sozinho.
 */

import { generateKeyPairSync } from 'node:crypto';
import forge from 'node-forge';

export interface TestCredentials {
  readonly privateKeyPem: string;
  readonly certificatePem: string;
}

export interface TestCredentialOptions {
  readonly notBefore?: Date;
  readonly notAfter?: Date;
}

const DAY = 24 * 60 * 60 * 1000;

export function createTestCredentials(options: TestCredentialOptions = {}): TestCredentials {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });

  const certificate = forge.pki.createCertificate();
  certificate.publicKey = forge.pki.publicKeyFromPem(publicKey);
  certificate.serialNumber = '01';
  certificate.validity.notBefore = options.notBefore ?? new Date(Date.now() - DAY);
  certificate.validity.notAfter = options.notAfter ?? new Date(Date.now() + 365 * DAY);

  const subject = [
    { name: 'commonName', value: 'EMPRESA DE TESTE LTDA:11222333000181' },
    { name: 'countryName', value: 'BR' },
    { name: 'organizationName', value: 'Certificado autoassinado para testes' },
  ];
  certificate.setSubject(subject);
  certificate.setIssuer(subject);
  certificate.sign(forge.pki.privateKeyFromPem(privateKey), forge.md.sha256.create());

  return { privateKeyPem: privateKey, certificatePem: forge.pki.certificateToPem(certificate) };
}
