/**
 * Cofre de segredos: AES-256-GCM com chave mestra fora do banco.
 *
 * O PFX e a senha do certificado nunca são gravados em claro. Cada segredo é
 * cifrado com IV aleatório e autenticado com um contexto (AAD) que o amarra a
 * tenant, emitente e finalidade: um texto cifrado copiado para outro emitente,
 * ou trocado entre PFX e senha, falha na abertura.
 *
 * Formato: `nfev1.<keyId>.<iv>.<tag>.<ciphertext>`, partes em base64url. O
 * `keyId` permite rotação: segredos antigos continuam abrindo enquanto a chave
 * antiga estiver no chaveiro.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { SecretVaultError } from './errors.js';

const FORMAT = 'nfev1';
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface MasterKey {
  readonly id: string;
  readonly material: Buffer;
}

export type Keyring = ReadonlyMap<string, MasterKey>;

/** Chave mestra de 32 bytes em base64, vinda de variável de ambiente ou KMS. */
export function parseMasterKey(id: string, base64Material: string): MasterKey {
  if (!KEY_ID.test(id)) {
    throw new SecretVaultError('INVALID_KEY', 'Identificador de chave mestra inválido.');
  }
  const material = Buffer.from(base64Material, 'base64');
  if (material.length !== KEY_LENGTH) {
    throw new SecretVaultError('INVALID_KEY', `A chave mestra deve ter ${KEY_LENGTH} bytes.`);
  }
  return { id, material };
}

export function createKeyring(...keys: MasterKey[]): Keyring {
  return new Map(keys.map((key) => [key.id, key]));
}

function additionalData(keyId: string, context: string): Buffer {
  return Buffer.from(`${FORMAT}|${keyId}|${context}`, 'utf8');
}

export function sealSecret(plaintext: Uint8Array | string, key: MasterKey, context: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key.material, iv, { authTagLength: TAG_LENGTH });
  cipher.setAAD(additionalData(key.id, context));
  const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : Buffer.from(plaintext);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  return [FORMAT, key.id, iv, cipher.getAuthTag(), ciphertext]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
    .join('.');
}

export function openSecret(sealed: string, keyring: Keyring, context: string): Buffer {
  const parts = sealed.split('.');
  const [format, keyId, iv, tag, ciphertext] = parts;
  if (
    parts.length !== 5 ||
    format !== FORMAT ||
    keyId === undefined ||
    iv === undefined ||
    tag === undefined ||
    ciphertext === undefined
  ) {
    throw new SecretVaultError('MALFORMED', 'Segredo cifrado em formato desconhecido.');
  }

  const key = keyring.get(keyId);
  if (key === undefined) {
    throw new SecretVaultError('UNKNOWN_KEY', `Chave mestra ${keyId} não está no chaveiro.`);
  }

  const ivBytes = Buffer.from(iv, 'base64url');
  const tagBytes = Buffer.from(tag, 'base64url');
  if (ivBytes.length !== IV_LENGTH || tagBytes.length !== TAG_LENGTH) {
    throw new SecretVaultError('MALFORMED', 'Segredo cifrado com IV ou tag de tamanho inválido.');
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key.material, ivBytes, { authTagLength: TAG_LENGTH });
    decipher.setAAD(additionalData(keyId, context));
    decipher.setAuthTag(tagBytes);
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]);
  } catch {
    throw new SecretVaultError(
      'AUTHENTICATION_FAILED',
      'O segredo não pôde ser aberto: foi alterado ou pertence a outro contexto.',
    );
  }
}
