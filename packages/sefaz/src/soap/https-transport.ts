/**
 * Transporte HTTPS com autenticação mútua (MOC 7.0, Visão Geral, 4.2.2: TLS 1.2
 * ou superior, com autenticação mútua).
 *
 * Duas decisões de segurança não são configuráveis:
 * - o certificado do servidor é sempre verificado, contra as raízes ICP-Brasil
 *   fixadas (`DEFAULT_SEFAZ_TRUST`) ou as informadas;
 * - TLS abaixo de 1.2 é recusado.
 *
 * A classificação das falhas decide se a NF-e pode ter sido processada:
 * - antes do handshake completo e do envio integral do corpo → `NOT_SENT`;
 * - depois disso, sem resposta completa → `SENT_WITHOUT_RESPONSE`.
 */

import https from 'node:https';
import { isIP } from 'node:net';
import { ProviderConfigurationError, SefazCommunicationError, type RequestPhase, type SefazOperation } from '../errors.js';
import type { SoapRequest } from './envelope.js';
import { DEFAULT_SEFAZ_TRUST } from './icp-brasil-roots.js';

export interface TlsClientCredentials {
  readonly privateKeyPem: string;
  readonly certificatePem: string;
  /** Certificados intermediários do titular, se houver. */
  readonly chainPem?: readonly string[];
}

export interface HttpsSoapTransportOptions {
  readonly credentials: TlsClientCredentials;
  /** Raízes aceitas para o certificado do servidor. Padrão: ICP-Brasil fixadas. */
  readonly trustedCertificatesPem?: readonly string[];
  readonly connectTimeoutMs?: number;
  readonly responseTimeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export interface SoapReply {
  readonly statusCode: number;
  readonly body: string;
}

export interface SoapTransport {
  post(operation: SefazOperation, request: SoapRequest): Promise<SoapReply>;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === undefined ? error.message : `${code}: ${error.message}`;
  }
  return 'falha sem detalhe';
}

export class HttpsSoapTransport implements SoapTransport {
  private readonly options: HttpsSoapTransportOptions;
  private readonly trusted: readonly string[];

  constructor(options: HttpsSoapTransportOptions) {
    this.options = options;
    this.trusted = options.trustedCertificatesPem ?? DEFAULT_SEFAZ_TRUST.map((root) => root.pem);
    if (this.trusted.length === 0) {
      throw new ProviderConfigurationError('O transporte com a SEFAZ exige ao menos uma raiz confiável.');
    }
  }

  post(operation: SefazOperation, request: SoapRequest): Promise<SoapReply> {
    return new Promise<SoapReply>((resolve, reject) => {
      const url = new URL(request.url);
      if (url.protocol !== 'https:') {
        reject(new ProviderConfigurationError('Os web services da SEFAZ exigem HTTPS.'));
        return;
      }

      const body = Buffer.from(request.body, 'utf8');
      const connectTimeoutMs = this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
      const responseTimeoutMs = this.options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
      const maxResponseBytes = this.options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
      const { credentials } = this.options;

      let handshakeDone = false;
      let bodyWritten = false;
      let settled = false;

      const phase = (): RequestPhase => (handshakeDone && bodyWritten ? 'SENT_WITHOUT_RESPONSE' : 'NOT_SENT');

      const req = https.request({
        protocol: 'https:',
        hostname: url.hostname,
        port: url.port === '' ? 443 : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        ...(isIP(url.hostname) === 0 ? { servername: url.hostname } : {}),
        key: credentials.privateKeyPem,
        cert: [credentials.certificatePem, ...(credentials.chainPem ?? [])].join('\n'),
        ca: [...this.trusted],
        minVersion: 'TLSv1.2',
        rejectUnauthorized: true,
        agent: false,
        headers: {
          'Content-Type': request.contentType,
          'Content-Length': body.length,
        },
      });

      const fail = (failurePhase: RequestPhase, message: string, cause?: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(connectTimer);
        req.destroy();
        reject(new SefazCommunicationError(operation, failurePhase, message, cause));
      };

      const connectTimer = setTimeout(() => {
        fail('NOT_SENT', 'Tempo de conexão com a SEFAZ esgotado.');
      }, connectTimeoutMs);

      req.on('socket', (socket) => {
        socket.once('secureConnect', () => {
          handshakeDone = true;
          clearTimeout(connectTimer);
        });
      });

      req.on('finish', () => {
        bodyWritten = true;
      });

      req.setTimeout(responseTimeoutMs, () => {
        fail(phase(), 'Tempo de resposta da SEFAZ esgotado.');
      });

      req.on('response', (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxResponseBytes) {
            fail('SENT_WITHOUT_RESPONSE', 'A resposta da SEFAZ excedeu o tamanho máximo aceito.');
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', (error) => {
          fail('SENT_WITHOUT_RESPONSE', `Conexão interrompida durante a resposta: ${describe(error)}`, error);
        });
        response.on('close', () => {
          if (!response.complete) {
            fail('SENT_WITHOUT_RESPONSE', 'A conexão foi encerrada antes do fim da resposta.');
          }
        });
        response.on('end', () => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(connectTimer);
          resolve({ statusCode: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
        });
      });

      req.on('error', (error) => {
        // Alerta TLS do servidor identificado pelo código (certificado de cliente
        // recusado, por exemplo) encerra a conexão antes de a aplicação ler a
        // requisição: nada foi processado. Quando o Node não expõe o alerta — no
        // TLS 1.3 a recusa chega depois de o corpo sair e aparece só como
        // ECONNRESET — a falha é indistinguível de uma queda após o recebimento
        // e segue a regra geral: desfecho desconhecido. Se "não enviado" estiver
        // errado, o reenvio cai em duplicidade (204) e vai para reconciliação.
        const code = (error as NodeJS.ErrnoException).code;
        const rejectedByTls = typeof code === 'string' && code.startsWith('ERR_SSL_') && code.includes('ALERT');
        fail(rejectedByTls ? 'NOT_SENT' : phase(), `Falha na comunicação com a SEFAZ: ${describe(error)}`, error);
      });

      req.end(body);
    });
  }
}
