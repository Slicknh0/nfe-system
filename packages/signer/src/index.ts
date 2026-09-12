export { XmlSignatureError, type SignatureFailureReason } from './errors.js';

export {
  SIGNATURE_ALGORITHMS,
  signInutilizationXml,
  signNfeXml,
  verifyInutilizationSignature,
  verifyNfeSignature,
  type SignOptions,
  type SignatureVerification,
  type SigningCredentials,
} from './xml-signer.js';
