/**
 * PKI de teste gerada em memória: AC raiz, certificados de pessoa jurídica com
 * CNPJ no otherName 2.16.76.1.3.3, certificados de servidor e PFX.
 *
 * Imita a estrutura dos certificados ICP-Brasil sem ser um: nenhuma credencial
 * real, nenhum arquivo gravado.
 */

import { generateKeyPairSync } from 'node:crypto';
import forge from 'node-forge';

const DAY = 24 * 60 * 60 * 1000;
const CNPJ_OID = '2.16.76.1.3.3';

export interface IssuedCertificate {
  readonly certificatePem: string;
  readonly privateKeyPem: string;
  readonly certificate: forge.pki.Certificate;
  readonly privateKey: forge.pki.rsa.PrivateKey;
}

export interface CertificateOptions {
  readonly commonName?: string;
  readonly cnpj?: string;
  readonly dnsNames?: readonly string[];
  readonly ipAddresses?: readonly string[];
  /** Com qualquer um dos dois definido, a extensão Extended Key Usage é incluída. */
  readonly clientAuth?: boolean;
  readonly serverAuth?: boolean;
  readonly digitalSignature?: boolean;
  readonly notBefore?: Date;
  readonly notAfter?: Date;
}

export interface PfxOptions {
  readonly includeRoot?: boolean;
  readonly rootFirst?: boolean;
  /** Chave a embutir no lugar da chave do certificado. */
  readonly privateKey?: forge.pki.rsa.PrivateKey;
}

let serialSequence = 1;

function nextSerial(): string {
  serialSequence += 1;
  return `01${serialSequence.toString(16).padStart(6, '0')}`;
}

function generateKeys(): { privateKey: forge.pki.rsa.PrivateKey; publicKey: forge.pki.PublicKey; privateKeyPem: string } {
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  return {
    privateKey: forge.pki.privateKeyFromPem(pair.privateKey),
    publicKey: forge.pki.publicKeyFromPem(pair.publicKey),
    privateKeyPem: pair.privateKey,
  };
}

function subjectAltName(options: CertificateOptions): string | undefined {
  const { asn1 } = forge;
  const names: forge.asn1.Asn1[] = [];
  if (options.cnpj !== undefined) {
    names.push(
      asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [
        asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(CNPJ_OID).getBytes()),
        asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [
          asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, options.cnpj),
        ]),
      ]),
    );
  }
  for (const dns of options.dnsNames ?? []) {
    names.push(asn1.create(asn1.Class.CONTEXT_SPECIFIC, 2, false, dns));
  }
  for (const ip of options.ipAddresses ?? []) {
    const bytes = ip.split('.').map((part) => String.fromCharCode(Number(part))).join('');
    names.push(asn1.create(asn1.Class.CONTEXT_SPECIFIC, 7, false, bytes));
  }
  if (names.length === 0) {
    return undefined;
  }
  return asn1.toDer(asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, names)).getBytes();
}

export class TestPki {
  readonly root: IssuedCertificate;

  constructor(commonName = 'AC Raiz de Teste') {
    const keys = generateKeys();
    const certificate = forge.pki.createCertificate();
    certificate.publicKey = keys.publicKey;
    certificate.serialNumber = nextSerial();
    certificate.validity.notBefore = new Date(Date.now() - DAY);
    certificate.validity.notAfter = new Date(Date.now() + 3650 * DAY);
    const subject = [
      { name: 'commonName', value: commonName },
      { name: 'organizationName', value: 'PKI de teste' },
      { name: 'countryName', value: 'BR' },
    ];
    certificate.setSubject(subject);
    certificate.setIssuer(subject);
    certificate.setExtensions([
      { name: 'basicConstraints', cA: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true },
    ]);
    certificate.sign(keys.privateKey, forge.md.sha256.create());
    this.root = {
      certificate,
      privateKey: keys.privateKey,
      privateKeyPem: keys.privateKeyPem,
      certificatePem: forge.pki.certificateToPem(certificate),
    };
  }

  issue(options: CertificateOptions = {}): IssuedCertificate {
    const keys = generateKeys();
    const certificate = forge.pki.createCertificate();
    certificate.publicKey = keys.publicKey;
    certificate.serialNumber = nextSerial();
    certificate.validity.notBefore = options.notBefore ?? new Date(Date.now() - DAY);
    certificate.validity.notAfter = options.notAfter ?? new Date(Date.now() + 365 * DAY);
    certificate.setSubject([
      { name: 'commonName', value: options.commonName ?? 'EMPRESA DE TESTE LTDA' },
      { name: 'organizationName', value: 'ICP de teste' },
      { name: 'countryName', value: 'BR' },
    ]);
    certificate.setIssuer(this.root.certificate.subject.attributes);

    const extensions: object[] = [
      { name: 'basicConstraints', cA: false },
      {
        name: 'keyUsage',
        digitalSignature: options.digitalSignature ?? true,
        nonRepudiation: true,
        keyEncipherment: true,
      },
    ];
    if (options.clientAuth !== undefined || options.serverAuth !== undefined) {
      extensions.push({
        name: 'extKeyUsage',
        clientAuth: options.clientAuth ?? false,
        serverAuth: options.serverAuth ?? false,
      });
    }
    const san = subjectAltName(options);
    if (san !== undefined) {
      extensions.push({ id: '2.5.29.17', critical: false, value: san });
    }
    certificate.setExtensions(extensions);
    certificate.sign(this.root.privateKey, forge.md.sha256.create());

    return {
      certificate,
      privateKey: keys.privateKey,
      privateKeyPem: keys.privateKeyPem,
      certificatePem: forge.pki.certificateToPem(certificate),
    };
  }

  toPfx(leaf: IssuedCertificate, passphrase: string, options: PfxOptions = {}): Buffer {
    const chain = options.includeRoot === false ? [leaf.certificate] : [leaf.certificate, this.root.certificate];
    const certificates = options.rootFirst === true ? [...chain].reverse() : chain;
    const asn1 = forge.pkcs12.toPkcs12Asn1(options.privateKey ?? leaf.privateKey, certificates, passphrase, {
      algorithm: '3des',
    });
    return Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary');
  }
}
