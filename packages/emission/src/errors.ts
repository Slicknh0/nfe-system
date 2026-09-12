/**
 * Erros da camada de aplicação.
 *
 * Os erros de conflito não são fiscais nem técnicos no sentido do domínio: eles
 * dizem que outra operação chegou antes. A resposta correta é reler o
 * documento, não repetir às cegas.
 */

import { FiscalError, type NfeStatus } from '@nfe/core';

export class InvoiceNotFoundError extends Error {
  constructor(readonly invoiceId: string) {
    super(`Documento ${invoiceId} não encontrado.`);
    this.name = 'InvoiceNotFoundError';
  }
}

export class IdempotencyConflictError extends Error {
  constructor(readonly idempotencyKey: string) {
    super('A chave de idempotência já foi usada com um conteúdo diferente.');
    this.name = 'IdempotencyConflictError';
  }
}

export class InvalidIdempotencyKeyError extends Error {
  constructor() {
    super('A chave de idempotência deve ter de 1 a 255 caracteres ASCII visíveis.');
    this.name = 'InvalidIdempotencyKeyError';
  }
}

/** O documento mudou entre a leitura e a escrita. */
export class ConcurrentModificationError extends Error {
  constructor(readonly invoiceId: string, detail: string) {
    super(`O documento ${invoiceId} foi alterado por outra operação: ${detail}`);
    this.name = 'ConcurrentModificationError';
  }
}

export class OperationNotAllowedError extends FiscalError {
  constructor(
    readonly operation: string,
    readonly status: NfeStatus,
  ) {
    super(`Não é possível ${operation} um documento em ${status}.`);
  }
}

/** `nNF` tem no máximo 9 dígitos (tipo `TNF` do schema). */
export class SeriesExhaustedError extends FiscalError {
  constructor(readonly series: number) {
    super(`A numeração da série ${series} chegou ao limite de 999999999.`);
  }
}

export class NumberedInvoiceChangeError extends FiscalError {
  constructor() {
    super('Série e ambiente não podem mudar depois que o documento recebeu número.');
  }
}

/** Recusa esperada do assinador: certificado vencido, chave divergente, credencial ilegível. */
export class SigningRefusedError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'SigningRefusedError';
  }
}
