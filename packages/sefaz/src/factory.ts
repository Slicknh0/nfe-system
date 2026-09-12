/**
 * Escolha do provider por configuração.
 *
 * O mock só existe para homologação. Isso é verificado aqui e de novo em cada
 * chamada do próprio mock: uma variável de ambiente errada não pode fazer o
 * sistema "autorizar" nota de produção sem falar com a SEFAZ.
 *
 * O provider SOAP recusa produção sem `productionEnabled` explícito.
 */

import { Environment } from '@nfe/core';
import { ProviderConfigurationError } from './errors.js';
import { MockSefazProvider } from './mock-provider.js';
import type { EnvironmentCode, SefazProvider } from './provider.js';
import type { EndpointCatalog } from './soap/endpoints.js';
import type { SoapTransport } from './soap/https-transport.js';
import { SoapSefazProvider } from './soap/soap-provider.js';

export type SefazProviderKind = 'mock' | 'soap';

export interface SoapProviderSettings {
  readonly transport: SoapTransport;
  readonly productionEnabled?: boolean;
  readonly endpoints?: EndpointCatalog;
}

export interface SefazProviderConfig {
  readonly kind: SefazProviderKind;
  readonly environment: EnvironmentCode;
  readonly soap?: SoapProviderSettings;
}

export function createSefazProvider(config: SefazProviderConfig): SefazProvider {
  switch (config.kind) {
    case 'mock':
      if (config.environment === Environment.Production) {
        throw new ProviderConfigurationError('O provider simulado não pode ser usado em produção.');
      }
      return new MockSefazProvider();
    case 'soap':
      if (config.soap === undefined) {
        throw new ProviderConfigurationError(
          'O provider SOAP exige transporte com o certificado de transmissão.',
        );
      }
      return new SoapSefazProvider({ environment: config.environment, ...config.soap });
    default: {
      const unreachable: never = config.kind;
      throw new ProviderConfigurationError(`Provider desconhecido: ${String(unreachable)}.`);
    }
  }
}
