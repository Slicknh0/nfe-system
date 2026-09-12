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
  NumberVoidRequest,
  NumberVoidResult,
  ProtocolQueryRequest,
  ProtocolQueryResult,
  SefazProvider,
  StatusReply,
  VoidProtocol,
} from './provider.js';

export {
  SefazStatus,
  classifyProtocolStatus,
  interpretAuthorizationResponse,
  interpretNumberVoidResponse,
  interpretProtocolQueryResponse,
  type AuthorizationResponse,
  type NumberVoidResponse,
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
  type MockVoidBehavior,
} from './mock-provider.js';

export {
  createSefazProvider,
  type SefazProviderConfig,
  type SefazProviderKind,
} from './factory.js';
