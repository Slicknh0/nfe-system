/**
 * Certificado A1: arquivo PKCS#12 (PFX) com chave privada e certificado.
 *
 * O PFX é lido pelo `node-forge`, e não pelo `tls.createSecureContext({ pfx })`,
 * porque certificados A1 ainda costumam usar algoritmos de cifra legados
 * (3DES, RC2) que o OpenSSL 3 do Node recusa sem o provider "legacy". O
 * resultado vira PEM, aceito tanto pela assinatura XML quanto pelo TLS.
 *
 * Regras de uso (MOC 7.0, Visão Geral, 4.2.3):
 * - assinatura: certificado com o CNPJ de um dos estabelecimentos da empresa
 *   emissora e "uso da chave" para assinatura digital;
 * - transmissão: certificado com o CNPJ do responsável pela transmissão e
 *   Extended Key Usage "Autenticação Cliente".
 */

import { X509Certificate, createPrivateKey } from 'node:crypto';
import { normalizeCnpj } from '@nfe/core';
import forge from 'node-forge';
import { CertificateError } from './errors.js';
import { extractIcpBrasilCnpj } from './icp-brasil.js';

const CLIENT_AUTHENTICATION_OID = '1.3.6.1.5.5.7.3.2';

export interface A1Certificate {
  readonly certificatePem: string;
  readonly privateKeyPem: string;
  /** Demais certificados do PFX (cadeia), sem o do titular. */
  readonly chainPem: readonly string[];
  readonly subject: string;
  readonly issuer: string;
  readonly serialNumber: string;
  readonly notBefore: Date;
  readonly notAfter: Date;
  readonly fingerprint256: string;
  /** CNPJ do titular (otherName 2.16.76.1.3.3). */
  readonly cnpj?: string;
  readonly allowsDigitalSignature: boolean;
  readonly allowsClientAuthentication: boolean;
}

interface Pkcs12Bag {
  readonly key?: forge.pki.PrivateKey;
  readonly cert?: forge.pki.Certificate;
}

function bagsOf(p12: forge.pkcs12.Pkcs12Pfx, bagType: string): Pkcs12Bag[] {
  return (p12.getBags({ bagType })[bagType] ?? []) as Pkcs12Bag[];
}

export function loadA1Certificate(pfx: Uint8Array, passphrase: string): A1Certificate {
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    const der = forge.util.createBuffer(Buffer.from(pfx).toString('binary'));
    p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(der), passphrase);
  } catch {
    // A mensagem original não carrega a senha, mas também não ajuda o usuário.
    throw new CertificateError(
      'UNREADABLE_OR_WRONG_PASSWORD',
      'Não foi possível abrir o certificado: arquivo PFX inválido ou senha incorreta.',
    );
  }

  const keys = [
    ...bagsOf(p12, forge.pki.oids.pkcs8ShroudedKeyBag as string),
    ...bagsOf(p12, forge.pki.oids.keyBag as string),
  ]
    .map((bag) => bag.key)
    .filter((key): key is forge.pki.PrivateKey => key !== undefined);
  const certificates = bagsOf(p12, forge.pki.oids.certBag as string)
    .map((bag) => bag.cert)
    .filter((certificate): certificate is forge.pki.Certificate => certificate !== undefined);

  const [privateKey] = keys;
  if (privateKey === undefined) {
    throw new CertificateError('NO_PRIVATE_KEY', 'O arquivo PFX não contém chave privada.');
  }
  if (keys.length > 1) {
    throw new CertificateError('MULTIPLE_PRIVATE_KEYS', 'O arquivo PFX contém mais de uma chave privada.');
  }
  if (certificates.length === 0) {
    throw new CertificateError('NO_CERTIFICATE', 'O arquivo PFX não contém certificado.');
  }

  const privateKeyPem = forge.pki.privateKeyToPem(privateKey);
  const nodeKey = createPrivateKey(privateKeyPem);
  const certificatePems = certificates.map((certificate) => forge.pki.certificateToPem(certificate));

  // O titular é o certificado da chave, qualquer que seja a ordem no arquivo.
  const leafIndex = certificatePems.findIndex((pem) => new X509Certificate(pem).checkPrivateKey(nodeKey));
  const leafPem = certificatePems[leafIndex];
  const forgeLeaf = certificates[leafIndex];
  if (leafPem === undefined || forgeLeaf === undefined) {
    throw new CertificateError(
      'KEY_CERTIFICATE_MISMATCH',
      'Nenhum certificado do arquivo PFX corresponde à chave privada.',
    );
  }

  const leaf = new X509Certificate(leafPem);
  const keyUsage = forgeLeaf.getExtension('keyUsage') as { digitalSignature?: boolean } | undefined;
  const cnpj = extractIcpBrasilCnpj(forgeLeaf);

  return {
    certificatePem: leafPem,
    privateKeyPem,
    chainPem: certificatePems.filter((_, index) => index !== leafIndex),
    subject: leaf.subject,
    issuer: leaf.issuer,
    serialNumber: leaf.serialNumber,
    notBefore: new Date(leaf.validFrom),
    notAfter: new Date(leaf.validTo),
    fingerprint256: leaf.fingerprint256,
    ...(cnpj === undefined ? {} : { cnpj }),
    // Extensão ausente significa uso não restrito (RFC 5280).
    allowsDigitalSignature: keyUsage === undefined || keyUsage.digitalSignature === true,
    allowsClientAuthentication:
      leaf.keyUsage === undefined || leaf.keyUsage.includes(CLIENT_AUTHENTICATION_OID),
  };
}

export type CertificatePurpose = 'SIGNING' | 'TRANSMISSION';

export interface UsageCheck {
  readonly purpose: CertificatePurpose;
  readonly now?: Date;
  /** CNPJ do emitente da NF-e. Obrigatório conferir na assinatura. */
  readonly issuerCnpj?: string;
}

/** Raiz do CNPJ: as 8 primeiras posições, comuns a todos os estabelecimentos. */
function cnpjRoot(cnpj: string): string {
  return normalizeCnpj(cnpj).slice(0, 8);
}

export function assertCertificateUsable(certificate: A1Certificate, check: UsageCheck): void {
  const now = check.now ?? new Date();
  if (now < certificate.notBefore) {
    throw new CertificateError(
      'NOT_YET_VALID',
      `O certificado só é válido a partir de ${certificate.notBefore.toISOString()}.`,
    );
  }
  if (now > certificate.notAfter) {
    throw new CertificateError('EXPIRED', `O certificado venceu em ${certificate.notAfter.toISOString()}.`);
  }
  if (certificate.cnpj === undefined) {
    throw new CertificateError(
      'MISSING_CNPJ',
      'O certificado não traz CNPJ no campo otherName 2.16.76.1.3.3, exigido para NF-e.',
    );
  }

  if (check.purpose === 'SIGNING') {
    if (!certificate.allowsDigitalSignature) {
      throw new CertificateError(
        'MISSING_DIGITAL_SIGNATURE',
        'O uso da chave do certificado não permite assinatura digital.',
      );
    }
    if (check.issuerCnpj !== undefined && cnpjRoot(certificate.cnpj) !== cnpjRoot(check.issuerCnpj)) {
      throw new CertificateError(
        'CNPJ_MISMATCH',
        'O certificado não pertence a um estabelecimento da empresa emitente.',
      );
    }
    return;
  }

  if (!certificate.allowsClientAuthentication) {
    throw new CertificateError(
      'MISSING_CLIENT_AUTHENTICATION',
      'O certificado não tem a finalidade "Autenticação Cliente", exigida na transmissão.',
    );
  }
}
