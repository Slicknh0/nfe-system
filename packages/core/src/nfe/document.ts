/**
 * Modelo de entrada do XML Builder da NF-e modelo 55.
 *
 * Os nomes são descritivos; o comentário de cada campo indica a tag do leiaute a
 * que corresponde, para quem conhece a NF-e pela nomenclatura oficial.
 *
 * Escopo desta fatia, deliberadamente restrito:
 * - emitente do Simples Nacional, ICMS pelo grupo `ICMSSN102`;
 * - PIS e COFINS pelos grupos `NT`, `Aliq` e `Outr` percentual;
 * - destinatário nacional, por CNPJ ou CPF;
 * - todos os itens compõem o total (`indTot = 1`);
 * - unidade e quantidade tributáveis iguais às comerciais.
 *
 * IBS, CBS e IS ficam fora por decisão fundamentada em fonte oficial: para
 * CRT=1 essa tributação só ocorre a partir de 2027, e a NT com o leiaute para
 * esses contribuintes ainda não foi publicada (NT 2025.002 v1.51, "Detalhamento
 * do Cronograma"). No XSD, `IS` e `IBSCBS` são `minOccurs="0"` e ocupam as duas
 * últimas posições de `imposto` — entram depois sem reordenar nada.
 *
 * Valores de tributo chegam já calculados. Calcular é papel do motor fiscal; o
 * builder só garante estrutura, formato e totalização coerente.
 */

import { FiscalError } from '../errors.js';
import type { Decimal } from '../money/decimal.js';

export class InvalidNfeDocumentError extends FiscalError {}

/** `tpAmb` */
export const Environment = { Production: 1, Homologation: 2 } as const;
export type Environment = (typeof Environment)[keyof typeof Environment];

/** `tpNF` */
export const OperationType = { Entry: 0, Exit: 1 } as const;
export type OperationType = (typeof OperationType)[keyof typeof OperationType];

/** `idDest` */
export const DestinationScope = { Internal: 1, Interstate: 2, Abroad: 3 } as const;
export type DestinationScope = (typeof DestinationScope)[keyof typeof DestinationScope];

/** `tpImp` — formato de impressão do DANFE. */
export const DanfePrintFormat = { None: 0, Portrait: 1, Landscape: 2 } as const;
export type DanfePrintFormat = (typeof DanfePrintFormat)[keyof typeof DanfePrintFormat];

/**
 * `tpEmis` aceitos para modelo 55.
 *
 * O XSD enumera 1, 2, 3, 4, 5, 6, 7 e 9. Ficam de fora, com motivo:
 * - 2 (FS-IA): legado, utilizável só até o fim do estoque de formulários
 *   (MOC 7.0, Anexo III);
 * - 3: o Anexo I do MOC descreve SCAN desativado, enquanto as regras de
 *   validação das NTs vigentes leem "3-NFF". Fica fora até a divergência entre
 *   documentos oficiais se resolver;
 * - 9 (offline): válido apenas para NFC-e, modelo 65 (MOC 7.0, Anexo I).
 */
export const EmissionType = { Normal: 1, Epec: 4, FsDa: 5, SvcAn: 6, SvcRs: 7 } as const;
export type EmissionType = (typeof EmissionType)[keyof typeof EmissionType];

export const NFE_ALLOWED_EMISSION_TYPES: ReadonlySet<number> = new Set(
  Object.values(EmissionType),
);

/** `finNFe` */
export const InvoicePurpose = { Normal: 1, Complementary: 2, Adjustment: 3, Return: 4 } as const;
export type InvoicePurpose = (typeof InvoicePurpose)[keyof typeof InvoicePurpose];

/** `indFinal` */
export const FinalConsumer = { No: 0, Yes: 1 } as const;
export type FinalConsumer = (typeof FinalConsumer)[keyof typeof FinalConsumer];

/** `indPres` — o valor 4 (entrega a domicílio) é próprio de NFC-e e fica de fora. */
export const BuyerPresence = {
  NotApplicable: 0,
  InPerson: 1,
  Internet: 2,
  Telephone: 3,
  InPersonOutsideEstablishment: 5,
  Other: 9,
} as const;
export type BuyerPresence = (typeof BuyerPresence)[keyof typeof BuyerPresence];

/** `indIntermed` */
export const IntermediaryIndicator = { NoIntermediary: 0, ThirdPartyPlatform: 1 } as const;
export type IntermediaryIndicator =
  (typeof IntermediaryIndicator)[keyof typeof IntermediaryIndicator];

/** `CRT` */
export const TaxRegime = {
  SimplesNacional: 1,
  SimplesNacionalExcessoSublimite: 2,
  Normal: 3,
  Mei: 4,
} as const;
export type TaxRegime = (typeof TaxRegime)[keyof typeof TaxRegime];

/** `indIEDest` */
export const StateRegistrationIndicator = {
  Contributor: 1,
  ExemptContributor: 2,
  NonContributor: 9,
} as const;
export type StateRegistrationIndicator =
  (typeof StateRegistrationIndicator)[keyof typeof StateRegistrationIndicator];

/** `modFrete` */
export const FreightMode = {
  ByIssuer: 0,
  ByRecipient: 1,
  ByThirdParty: 2,
  OwnVehicleIssuer: 3,
  OwnVehicleRecipient: 4,
  NoFreight: 9,
} as const;
export type FreightMode = (typeof FreightMode)[keyof typeof FreightMode];

/** `indPag` */
export const PaymentIndicator = { Immediate: 0, Deferred: 1 } as const;
export type PaymentIndicator = (typeof PaymentIndicator)[keyof typeof PaymentIndicator];

/** `orig` — tabela `Torig` do leiaute, valores 0 a 8. */
export type ProductOrigin = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface ContingencyEntry {
  /** `dhCont` */
  readonly enteredAt: Date;
  /** `xJust` */
  readonly justification: string;
}

export interface Identification {
  /** `cUF` */
  readonly stateCode: number;
  /** `cNF` — 8 dígitos. */
  readonly randomCode: string;
  /** `natOp` */
  readonly operationNature: string;
  /** `serie` */
  readonly series: number;
  /** `nNF` */
  readonly number: number;
  /** `dhEmi` */
  readonly issuedAt: Date;
  /** Fuso IANA do estabelecimento; define AAMM da chave e o deslocamento de `dhEmi`. */
  readonly timeZone: string;
  readonly operationType: OperationType;
  readonly destinationScope: DestinationScope;
  /** `cMunFG` — código IBGE do município do fato gerador. */
  readonly municipalityCode: string;
  readonly printFormat: DanfePrintFormat;
  readonly emissionType: EmissionType;
  readonly environment: Environment;
  readonly purpose: InvoicePurpose;
  readonly finalConsumer: FinalConsumer;
  readonly buyerPresence: BuyerPresence;
  readonly intermediary?: IntermediaryIndicator;
  /** `verProc` */
  readonly applicationVersion: string;
  /** Obrigatório quando `emissionType` não é normal; proibido quando é. */
  readonly contingency?: ContingencyEntry;
}

export interface Address {
  /** `xLgr` */
  readonly street: string;
  /** `nro` */
  readonly number: string;
  /** `xCpl` */
  readonly complement?: string;
  /** `xBairro` */
  readonly district: string;
  /** `cMun` */
  readonly municipalityCode: string;
  /** `xMun` */
  readonly municipalityName: string;
  /** `UF` */
  readonly state: string;
  /** `CEP` — 8 dígitos, sem máscara. */
  readonly postalCode: string;
  /** `fone` — só dígitos. */
  readonly phone?: string;
}

export interface MunicipalRegistration {
  /** `IM` */
  readonly number: string;
  /** `CNAE` — no leiaute só pode aparecer junto de `IM`. */
  readonly cnae?: string;
}

export interface Issuer {
  readonly cnpj: string;
  /** `xNome` */
  readonly legalName: string;
  /** `xFant` */
  readonly tradeName?: string;
  readonly address: Address;
  /** `IE` */
  readonly stateRegistration: string;
  readonly municipalRegistration?: MunicipalRegistration;
  /** `CRT` */
  readonly taxRegime: TaxRegime;
}

export type RecipientDocument =
  | { readonly type: 'CNPJ'; readonly value: string }
  | { readonly type: 'CPF'; readonly value: string };

export interface Recipient {
  readonly document: RecipientDocument;
  /** `xNome` */
  readonly name: string;
  readonly address: Address;
  readonly stateRegistrationIndicator: StateRegistrationIndicator;
  /** `IE` — exigida quando o destinatário é contribuinte (`indIEDest = 1`). */
  readonly stateRegistration?: string;
  readonly email?: string;
}

/** `ICMSSN102` — Simples Nacional sem permissão de crédito. */
export interface IcmsSimplesNacional102 {
  readonly kind: 'SimplesNacional102';
  readonly origin: ProductOrigin;
  /** Enumeração do XSD para este grupo: 102, 103, 300 ou 400. */
  readonly csosn: '102' | '103' | '300' | '400';
}

export type IcmsGroup = IcmsSimplesNacional102;

/**
 * Grupos de PIS e COFINS, que têm a mesma forma.
 *
 * - `NonTaxed` → `PISNT` / `COFINSNT`
 * - `Rate` → `PISAliq` / `COFINSAliq`
 * - `Other` → `PISOutr` / `COFINSOutr`, na variante percentual
 *
 * O CST é informado pelo motor fiscal. Qual CST se aplica a cada operação é
 * regra tributária e não é decidido aqui.
 */
export type SocialContributionGroup =
  | { readonly kind: 'NonTaxed'; readonly cst: string }
  | {
      readonly kind: 'Rate' | 'Other';
      readonly cst: string;
      /** `vBC` */
      readonly base: Decimal;
      /** `pPIS` / `pCOFINS`, em percentual. */
      readonly rate: Decimal;
      /** `vPIS` / `vCOFINS`, já arredondado a duas casas. */
      readonly amount: Decimal;
    };

export interface ItemTaxes {
  readonly icms: IcmsGroup;
  readonly pis: SocialContributionGroup;
  readonly cofins: SocialContributionGroup;
}

export interface InvoiceItem {
  /** `cProd` */
  readonly productCode: string;
  /** `cEAN` e `cEANTrib`; ausente vira `SEM GTIN`. */
  readonly gtin?: string;
  /** `xProd` */
  readonly description: string;
  readonly ncm: string;
  readonly cest?: string;
  readonly cfop: string;
  /** `uCom` e `uTrib` */
  readonly unit: string;
  /** `qCom` e `qTrib`, até 4 casas. */
  readonly quantity: Decimal;
  /** `vUnCom` e `vUnTrib`, até 10 casas. */
  readonly unitPrice: Decimal;
  /** `vFrete` */
  readonly freight?: Decimal;
  /** `vSeg` */
  readonly insurance?: Decimal;
  /** `vDesc` */
  readonly discount?: Decimal;
  /** `vOutro` */
  readonly otherExpenses?: Decimal;
  readonly taxes: ItemTaxes;
  /** `infAdProd` */
  readonly additionalInformation?: string;
}

export interface Transport {
  readonly freightMode: FreightMode;
}

export interface PaymentEntry {
  readonly indicator?: PaymentIndicator;
  /** `tPag` — código de 2 dígitos da tabela vigente de meios de pagamento. */
  readonly method: string;
  /** `vPag` */
  readonly amount: Decimal;
}

export interface Payment {
  readonly entries: readonly PaymentEntry[];
  /** `vTroco` */
  readonly change?: Decimal;
}

export interface AdditionalInformation {
  /** `infAdFisco` */
  readonly forTaxAuthority?: string;
  /** `infCpl` */
  readonly complementary?: string;
}

export interface TechnicalResponsible {
  readonly cnpj: string;
  /** `xContato` */
  readonly contactName: string;
  readonly email: string;
  /** `fone` — só dígitos. */
  readonly phone: string;
}

export interface NfeDocument {
  readonly identification: Identification;
  readonly issuer: Issuer;
  readonly recipient: Recipient;
  readonly items: readonly InvoiceItem[];
  readonly transport: Transport;
  readonly payment: Payment;
  readonly additionalInformation?: AdditionalInformation;
  readonly technicalResponsible?: TechnicalResponsible;
}
