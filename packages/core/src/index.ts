/**
 * `@nfe/core` — domínio fiscal puro.
 *
 * Este pacote não importa NestJS, Prisma, HTTP nem acessa rede. É a fronteira
 * que impede lógica fiscal de vazar para controllers e telas: tudo que decide
 * valor, chave, estado ou estrutura de documento mora aqui e é testável sem
 * subir container.
 */

export {
  ALPHANUMERIC_DOMAIN,
  InvalidCharacterError,
  charNumericValue,
  mod11CheckDigit,
} from './fiscal/mod11.js';

export {
  ACCESS_KEY_LENGTH,
  AccessKeyValidationError,
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
  canTransition,
  isEditable,
  isTerminal,
  reachableFrom,
} from './nfe/state-machine.js';
