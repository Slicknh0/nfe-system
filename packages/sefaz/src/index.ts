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
  type SoapProviderSettings,
} from './factory.js';

export {
  PORTAL_NAMESPACE,
  SEFAZ_SP_ENDPOINTS,
  soapAction,
  soapNamespace,
  type EndpointCatalog,
  type SefazService,
  type ServiceEndpoint,
} from './soap/endpoints.js';

export {
  SOAP_12_NAMESPACE,
  buildSoapRequest,
  stripXmlDeclaration,
  type SoapRequest,
} from './soap/envelope.js';

export {
  SefazResponseError,
  SoapFaultError,
  readAuthorizationResponse,
  readNumberVoidResponse,
  readProtocolQueryResponse,
  readSoapFault,
} from './soap/response-reader.js';

export {
  HttpsSoapTransport,
  type HttpsSoapTransportOptions,
  type SoapReply,
  type SoapTransport,
  type TlsClientCredentials,
} from './soap/https-transport.js';

export { SoapSefazProvider, type SoapSefazProviderOptions } from './soap/soap-provider.js';

export { DEFAULT_SEFAZ_TRUST, ICP_BRASIL_ROOT_V10, type TrustedRoot } from './soap/icp-brasil-roots.js';
