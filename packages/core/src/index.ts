/**
 * `@nfe/core` — domínio fiscal puro.
 *
 * Este pacote não importa NestJS, Prisma, HTTP nem acessa rede. É a fronteira
 * que impede lógica fiscal de vazar para controllers e telas: tudo que decide
 * valor, chave, estado ou estrutura de documento mora aqui e é testável sem
 * subir container.
 */

export {
  FiscalError,
  NfeError,
  TechnicalError,
  isFiscalError,
  isTechnicalError,
  requiresReconciliation,
  type ErrorKind,
} from './errors.js';

export {
  ALPHANUMERIC_DOMAIN,
  InvalidCharacterError,
  charNumericValue,
  mod11CheckDigit,
} from './fiscal/mod11.js';

export {
  CNPJ_BASE_LENGTH,
  CNPJ_LENGTH,
  InvalidCnpjError,
  assertValidCnpj,
  calculateCnpjCheckDigits,
  formatCnpj,
  isValidCnpj,
  normalizeCnpj,
} from './fiscal/cnpj.js';

export {
  ACCESS_KEY_LENGTH,
  AccessKeyValidationError,
  DEFAULT_ISSUER_TIME_ZONE,
  NFE_MODEL,
  buildAccessKey,
  isValidAccessKey,
  parseAccessKey,
  type AccessKeyInput,
  type ParsedAccessKey,
} from './fiscal/access-key.js';

export { Decimal, DecimalError, RoundingMode, allocate } from './money/decimal.js';

export {
  InvalidTransitionError,
  NfeStatus,
  assertTransition,
  canReachTransmissionWithoutResolution,
  canTransition,
  isEditable,
  isResolved,
  isTerminal,
  reachableFrom,
} from './nfe/state-machine.js';
