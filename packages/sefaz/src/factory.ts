/**
 * Escolha do provider por configuração.
 *
 * O mock só existe para homologação. Isso é verificado aqui e de novo em cada
 * chamada do próprio mock: uma variável de ambiente errada não pode fazer o
 * sistema "autorizar" nota de produção sem falar com a SEFAZ.
 */

import { Environment } from '@nfe/core';
import { ProviderConfigurationError } from './errors.js';
import { MockSefazProvider } from './mock-provider.js';
import type { EnvironmentCode, SefazProvider } from './provider.js';

export type SefazProviderKind = 'mock' | 'soap';

export interface SefazProviderConfig {
  readonly kind: SefazProviderKind;
  readonly environment: EnvironmentCode;
}

export function createSefazProvider(config: SefazProviderConfig): SefazProvider {
  switch (config.kind) {
    case 'mock':
      if (config.environment === Environment.Production) {
        throw new ProviderConfigurationError('O provider simulado não pode ser usado em produção.');
      }
      return new MockSefazProvider();
    case 'soap':
      throw new ProviderConfigurationError(
        'O provider SOAP da SEFAZ ainda não foi implementado. Ele exige certificado A1 e credenciamento em homologação.',
      );
    default: {
      const unreachable: never = config.kind;
      throw new ProviderConfigurationError(`Provider desconhecido: ${String(unreachable)}.`);
    }
  }
}
