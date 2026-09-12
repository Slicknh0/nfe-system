/**
 * SEFAZ local para testes do transporte SOAP: servidor HTTPS com autenticação
 * mútua de verdade, certificados da PKI de teste e respostas roteirizadas.
 *
 * Não imita regra fiscal: devolve exatamente o que cada teste mandar, para
 * exercitar TLS, envelope, leitura de retorno e classificação de falhas.
 */

import { once } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';
import type { IssuedCertificate } from '../../../../certificates/tests/support/test-pki.js';
import type { EndpointCatalog } from '../../../src/index.js';

export const SOAP_ENVELOPE_NAMESPACE = 'http://www.w3.org/2003/05/soap-envelope';

export interface RecordedRequest {
  readonly path: string;
  readonly contentType: string | undefined;
  readonly body: string;
  readonly clientCommonName: string | undefined;
}

export type Responder = (request: RecordedRequest, exchange: { req: IncomingMessage; res: ServerResponse }) => void;

export interface FakeSefazOptions {
  readonly serverCertificate: IssuedCertificate;
  readonly trustedClientRootsPem: readonly string[];
}

export class FakeSefaz {
  readonly requests: RecordedRequest[] = [];
  private readonly queue: Responder[] = [];
  private readonly server: https.Server;
  readonly port: number;

  private constructor(server: https.Server, port: number) {
    this.server = server;
    this.port = port;
  }

  static async start(options: FakeSefazOptions): Promise<FakeSefaz> {
    const holder: { instance?: FakeSefaz } = {};
    const server = https.createServer(
      {
        key: options.serverCertificate.privateKeyPem,
        cert: options.serverCertificate.certificatePem,
        ca: [...options.trustedClientRootsPem],
        requestCert: true,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
      },
      (req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => holder.instance?.handle(req, res, Buffer.concat(chunks).toString('utf8')));
      },
    );
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    holder.instance = new FakeSefaz(server, (server.address() as AddressInfo).port);
    return holder.instance;
  }

  /** Respostas das próximas requisições, em ordem. */
  respondWith(...responders: Responder[]): this {
    this.queue.push(...responders);
    return this;
  }

  endpoints(): EndpointCatalog {
    const base = `https://localhost:${this.port}/ws`;
    return {
      AUTHORIZATION: { url: `${base}/nfeautorizacao4.asmx`, operation: 'NFeAutorizacao4', method: 'nfeAutorizacaoLote' },
      PROTOCOL_QUERY: {
        url: `${base}/nfeconsultaprotocolo4.asmx`,
        operation: 'NFeConsultaProtocolo4',
        method: 'nfeConsultaNF',
      },
      NUMBER_VOID: { url: `${base}/nfeinutilizacao4.asmx`, operation: 'NFeInutilizacao4', method: 'nfeInutilizacaoNF' },
    };
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    const closed = once(this.server, 'close');
    this.server.close();
    await closed;
  }

  private handle(req: IncomingMessage, res: ServerResponse, body: string): void {
    const peer = (req.socket as TLSSocket).getPeerCertificate();
    const commonName = peer.subject?.CN;
    const request: RecordedRequest = {
      path: req.url ?? '',
      contentType: req.headers['content-type'],
      body,
      clientCommonName: Array.isArray(commonName) ? commonName.join(',') : commonName,
    };
    this.requests.push(request);

    const responder = this.queue.shift();
    if (responder === undefined) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('resposta não roteirizada');
      return;
    }
    responder(request, { req, res });
  }
}

function envelope(content: string): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    `<soap:Envelope xmlns:soap="${SOAP_ENVELOPE_NAMESPACE}"><soap:Body>${content}</soap:Body></soap:Envelope>`
  );
}

/** HTTP 200 com o retorno dentro de `nfeResultMsg`. */
export function soapResultFrom(build: (request: RecordedRequest) => string, operation = 'NFeAutorizacao4'): Responder {
  return (request, { res }) => {
    res.writeHead(200, { 'Content-Type': 'application/soap+xml; charset=utf-8' });
    res.end(
      envelope(`<nfeResultMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/${operation}">${build(request)}</nfeResultMsg>`),
    );
  };
}

export function soapResult(xml: string, operation?: string): Responder {
  return soapResultFrom(() => xml, operation);
}

export function soapFault(reason: string): Responder {
  return (_request, { res }) => {
    res.writeHead(500, { 'Content-Type': 'application/soap+xml; charset=utf-8' });
    res.end(
      envelope(
        '<soap:Fault><soap:Code><soap:Value>soap:Receiver</soap:Value></soap:Code>' +
          `<soap:Reason><soap:Text xml:lang="pt-BR">${reason}</soap:Text></soap:Reason></soap:Fault>`,
      ),
    );
  };
}

export function httpStatus(statusCode: number): Responder {
  return (_request, { res }) => {
    res.writeHead(statusCode, { 'Content-Type': 'text/html' });
    res.end(`<html><body>${statusCode}</body></html>`);
  };
}

/** Recebe a requisição inteira e derruba a conexão sem responder. */
export function dropConnection(): Responder {
  return (_request, { req }) => {
    req.socket.destroy();
  };
}

/** Recebe a requisição e nunca responde. */
export function neverRespond(): Responder {
  return () => undefined;
}

/** Conteúdo de `nfeDadosMsg` enviado pelo cliente. */
export function payloadOf(request: RecordedRequest): string {
  const match = /<nfeDadosMsg xmlns="[^"]+">([\s\S]*)<\/nfeDadosMsg>/.exec(request.body);
  if (match?.[1] === undefined) {
    throw new Error('Requisição sem nfeDadosMsg.');
  }
  return match[1];
}
