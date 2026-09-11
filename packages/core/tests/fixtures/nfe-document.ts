/**
 * Documento fictício de referência: emitente do Simples Nacional em São Paulo
 * vendendo a consumidor final pessoa física.
 *
 * Dados cadastrais inventados, com dígitos verificadores válidos. CST de PIS e
 * COFINS e demais escolhas tributárias são ilustrativos para exercitar a
 * estrutura do XML — não são orientação fiscal.
 */

import { Decimal } from '../../src/money/decimal.js';
import {
  BuyerPresence,
  DanfePrintFormat,
  DestinationScope,
  EmissionType,
  Environment,
  FinalConsumer,
  FreightMode,
  InvoicePurpose,
  OperationType,
  PaymentIndicator,
  StateRegistrationIndicator,
  TaxRegime,
  type InvoiceItem,
  type NfeDocument,
} from '../../src/nfe/document.js';

export const d = (value: string): Decimal => Decimal.parse(value);

export function makeItem(overrides: Partial<InvoiceItem> = {}): InvoiceItem {
  return {
    productCode: 'CAM-001',
    description: 'Camiseta de algodão',
    ncm: '61091000',
    cfop: '5102',
    unit: 'UN',
    quantity: d('2'),
    unitPrice: d('49.90'),
    taxes: {
      icms: { kind: 'SimplesNacional102', origin: 0, csosn: '102' },
      pis: { kind: 'Other', cst: '99', base: d('0'), rate: d('0'), amount: d('0') },
      cofins: { kind: 'Other', cst: '99', base: d('0'), rate: d('0'), amount: d('0') },
    },
    ...overrides,
  };
}

export function makeDocument(overrides: Partial<NfeDocument> = {}): NfeDocument {
  return {
    identification: {
      stateCode: 35,
      randomCode: '48213967',
      operationNature: 'Venda de mercadoria',
      series: 1,
      number: 1523,
      issuedAt: new Date('2026-09-11T10:15:30-03:00'),
      timeZone: 'America/Sao_Paulo',
      operationType: OperationType.Exit,
      destinationScope: DestinationScope.Internal,
      municipalityCode: '3550308',
      printFormat: DanfePrintFormat.Portrait,
      emissionType: EmissionType.Normal,
      environment: Environment.Homologation,
      purpose: InvoicePurpose.Normal,
      finalConsumer: FinalConsumer.Yes,
      buyerPresence: BuyerPresence.InPerson,
      applicationVersion: 'nfe-system 0.1.0',
    },
    issuer: {
      cnpj: '11222333000181',
      legalName: 'Loja Exemplo Comercio de Roupas Ltda',
      tradeName: 'Loja Exemplo',
      address: {
        street: 'Avenida Paulista',
        number: '1000',
        district: 'Bela Vista',
        municipalityCode: '3550308',
        municipalityName: 'São Paulo',
        state: 'SP',
        postalCode: '01310100',
        phone: '1133334444',
      },
      stateRegistration: '123456789012',
      taxRegime: TaxRegime.SimplesNacional,
    },
    recipient: {
      document: { type: 'CPF', value: '52998224725' },
      name: 'Maria da Silva',
      address: {
        street: 'Rua Augusta',
        number: '500',
        complement: 'Apto 12',
        district: 'Consolação',
        municipalityCode: '3550308',
        municipalityName: 'São Paulo',
        state: 'SP',
        postalCode: '01305000',
      },
      stateRegistrationIndicator: StateRegistrationIndicator.NonContributor,
      email: 'maria@example.com',
    },
    items: [makeItem()],
    transport: { freightMode: FreightMode.NoFreight },
    payment: {
      entries: [{ indicator: PaymentIndicator.Immediate, method: '01', amount: d('99.80') }],
    },
    ...overrides,
  };
}
