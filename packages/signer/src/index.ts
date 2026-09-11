export { XmlSignatureError, type SignatureFailureReason } from './errors.js';

export {
  SIGNATURE_ALGORITHMS,
  signNfeXml,
  verifyNfeSignature,
  type SignOptions,
  type SignatureVerification,
  type SigningCredentials,
} from './xml-signer.js';
