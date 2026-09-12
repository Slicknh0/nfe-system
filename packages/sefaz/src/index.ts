/**
 * `@nfe/sefaz` — contrato com a SEFAZ autorizadora, interpretação de cStat e
 * SEFAZ simulada para homologação.
 */

export {
  ProviderConfigurationError,
  SefazCommunicationError,
  type RequestPhase,
  type SefazOperation,
} from './errors.js';

export type {
  AuthorizationRequest,
  AuthorizationResult,
  EnvironmentCode,
  InvoiceProtocol,
  ProtocolQueryRequest,
  ProtocolQueryResult,
  SefazProvider,
  StatusReply,
} from './provider.js';

export {
  SefazStatus,
  classifyProtocolStatus,
  interpretAuthorizationResponse,
  interpretProtocolQueryResponse,
  type AuthorizationResponse,
  type ProtocolQueryResponse,
  type ProtocolStatusClass,
} from './status-codes.js';

export {
  MockSefazProvider,
  type DenialCode,
  type MockAuthorizationBehavior,
  type MockQueryBehavior,
  type MockSefazCall,
  type MockSefazOptions,
} from './mock-provider.js';

export {
  createSefazProvider,
  type SefazProviderConfig,
  type SefazProviderKind,
} from './factory.js';
