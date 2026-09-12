/**
 * `SefazProvider` real: web services SOAP da SEFAZ-SP.
 *
 * Mensagens (MOC 7.0, Visão Geral, capítulo 5):
 * - autorização: `enviNFe` com uma única NF-e e `indSinc=1` (processamento
 *   síncrono só com uma NF-e no lote, 5.1.1);
 * - consulta: `consSitNFe` com `xServ=CONSULTAR`;
 * - inutilização: o `inutNFe` assinado, como recebido.
 *
 * Produção só com `productionEnabled: true` explícito.
 */

import { randomInt } from 'node:crypto';
import { Environment } from '@nfe/core';
import { ProviderConfigurationError, SefazCommunicationError, type SefazOperation } from '../errors.js';
import type {
  AuthorizationRequest,
  AuthorizationResult,
  EnvironmentCode,
  NumberVoidRequest,
  NumberVoidResult,
  ProtocolQueryRequest,
  ProtocolQueryResult,
  SefazProvider,
} from '../provider.js';
import {
  interpretAuthorizationResponse,
  interpretNumberVoidResponse,
  interpretProtocolQueryResponse,
} from '../status-codes.js';
import { PORTAL_NAMESPACE, SEFAZ_SP_ENDPOINTS, type EndpointCatalog, type ServiceEndpoint } from './endpoints.js';
import { buildSoapRequest, stripXmlDeclaration } from './envelope.js';
import type { SoapTransport } from './https-transport.js';
import {
  SefazResponseError,
  SoapFaultError,
  readAuthorizationResponse,
  readNumberVoidResponse,
  readProtocolQueryResponse,
  readSoapFault,
} from './response-reader.js';

const LAYOUT_VERSION = '4.00';
/** `TIdLote`. */
const BATCH_ID = /^[0-9]{1,15}$/;
/** `TChNFe`. */
const ACCESS_KEY = /^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$/;

export interface SoapSefazProviderOptions {
  readonly environment: EnvironmentCode;
  readonly transport: SoapTransport;
  /** Padrão: web services da SEFAZ-SP no ambiente informado. */
  readonly endpoints?: EndpointCatalog;
  readonly productionEnabled?: boolean;
  /** Gerador de `idLote`. Padrão: instante em milissegundos e dois dígitos aleatórios. */
  readonly batchId?: () => string;
}

function defaultBatchId(): string {
  return `${String(Date.now()).slice(-13)}${String(randomInt(0, 100)).padStart(2, '0')}`;
}

export class SoapSefazProvider implements SefazProvider {
  readonly name = 'sefaz-soap';

  private readonly environment: EnvironmentCode;
  private readonly transport: SoapTransport;
  private readonly endpoints: EndpointCatalog;
  private readonly batchId: () => string;

  constructor(options: SoapSefazProviderOptions) {
    if (options.environment === Environment.Production && options.productionEnabled !== true) {
      throw new ProviderConfigurationError(
        'Transmissão para o ambiente de produção exige liberação explícita (productionEnabled).',
      );
    }
    this.environment = options.environment;
    this.transport = options.transport;
    this.endpoints = options.endpoints ?? SEFAZ_SP_ENDPOINTS[options.environment];
    this.batchId = options.batchId ?? defaultBatchId;
  }

  async authorize(request: AuthorizationRequest): Promise<AuthorizationResult> {
    this.assertEnvironment(request.environment);
    const batchId = this.batchId();
    if (!BATCH_ID.test(batchId)) {
      throw new ProviderConfigurationError('idLote fora do formato TIdLote (1 a 15 dígitos).');
    }
    const payload =
      `<enviNFe xmlns="${PORTAL_NAMESPACE}" versao="${LAYOUT_VERSION}">` +
      `<idLote>${batchId}</idLote><indSinc>1</indSinc>${stripXmlDeclaration(request.signedXml)}</enviNFe>`;
    const body = await this.exchange('AUTHORIZATION', this.endpoints.AUTHORIZATION, payload);
    return interpretAuthorizationResponse(
      this.read('AUTHORIZATION', () => readAuthorizationResponse(body, this.environment)),
    );
  }

  async queryProtocol(request: ProtocolQueryRequest): Promise<ProtocolQueryResult> {
    this.assertEnvironment(request.environment);
    if (!ACCESS_KEY.test(request.accessKey)) {
      throw new ProviderConfigurationError('Chave de acesso fora do formato TChNFe.');
    }
    const payload =
      `<consSitNFe xmlns="${PORTAL_NAMESPACE}" versao="${LAYOUT_VERSION}">` +
      `<tpAmb>${request.environment}</tpAmb><xServ>CONSULTAR</xServ><chNFe>${request.accessKey}</chNFe></consSitNFe>`;
    const body = await this.exchange('PROTOCOL_QUERY', this.endpoints.PROTOCOL_QUERY, payload);
    return interpretProtocolQueryResponse(
      this.read('PROTOCOL_QUERY', () => readProtocolQueryResponse(body, this.environment)),
    );
  }

  async voidNumbers(request: NumberVoidRequest): Promise<NumberVoidResult> {
    this.assertEnvironment(request.environment);
    const body = await this.exchange('NUMBER_VOID', this.endpoints.NUMBER_VOID, request.signedXml);
    return interpretNumberVoidResponse(
      this.read('NUMBER_VOID', () => readNumberVoidResponse(body, this.environment)),
    );
  }

  private assertEnvironment(environment: EnvironmentCode): void {
    if (environment !== this.environment) {
      throw new ProviderConfigurationError(
        `O provider foi configurado para o ambiente ${this.environment}, mas o documento é do ambiente ${environment}.`,
      );
    }
  }

  private async exchange(operation: SefazOperation, endpoint: ServiceEndpoint, payload: string): Promise<string> {
    const reply = await this.transport.post(operation, buildSoapRequest(endpoint, payload));
    if (reply.statusCode === 200) {
      return reply.body;
    }
    // 4xx: a requisição foi recusada antes de qualquer processamento (endereço,
    // certificado, formato). Nada foi processado, mas é problema de configuração.
    if (reply.statusCode >= 400 && reply.statusCode < 500) {
      throw new ProviderConfigurationError(
        `A SEFAZ recusou a requisição antes de processar (HTTP ${reply.statusCode}). Verifique endereço e certificado de transmissão.`,
      );
    }
    const fault = readSoapFault(reply.body);
    throw new SefazCommunicationError(
      operation,
      'SENT_WITHOUT_RESPONSE',
      `A SEFAZ respondeu HTTP ${reply.statusCode} sem resultado utilizável${fault === undefined ? '' : `: ${fault}`}.`,
    );
  }

  private read<T>(operation: SefazOperation, parse: () => T): T {
    try {
      return parse();
    } catch (error) {
      if (error instanceof SoapFaultError || error instanceof SefazResponseError) {
        throw new SefazCommunicationError(operation, 'SENT_WITHOUT_RESPONSE', error.message, error);
      }
      throw error;
    }
  }
}
