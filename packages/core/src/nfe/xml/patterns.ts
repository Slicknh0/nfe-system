/**
 * Formatos de campos codificados do leiaute.
 *
 * Conferidos localmente para que o erro aponte o campo em linguagem de negócio
 * antes da validação de schema. O XSD continua sendo a validação definitiva:
 * o que não estiver aqui é pego por ela.
 */

export interface CodePattern {
  readonly regex: RegExp;
  /** Descrição do formato esperado, usada na mensagem de erro. */
  readonly expected: string;
}

export const MUNICIPALITY_CODE: CodePattern = {
  regex: /^[0-9]{7}$/,
  expected: 'código IBGE do município com 7 dígitos',
};

export const POSTAL_CODE: CodePattern = {
  regex: /^[0-9]{8}$/,
  expected: 'CEP com 8 dígitos, sem máscara',
};

export const STATE: CodePattern = {
  regex: /^[A-Z]{2}$/,
  expected: 'sigla da UF com 2 letras maiúsculas',
};

export const PHONE: CodePattern = {
  regex: /^[0-9]{6,14}$/,
  expected: 'telefone com 6 a 14 dígitos, sem máscara',
};

/** Tipo `TIe` do PL_010f_v1.04. */
export const STATE_REGISTRATION: CodePattern = {
  regex: /^(?:[0-9]{2,14}|ISENTO)$/,
  expected: 'inscrição estadual com 2 a 14 dígitos, ou ISENTO',
};

export const NCM: CodePattern = {
  regex: /^(?:[0-9]{2}|[0-9]{8})$/,
  expected: 'NCM com 8 dígitos',
};

export const CEST: CodePattern = {
  regex: /^[0-9]{7}$/,
  expected: 'CEST com 7 dígitos',
};

export const CFOP: CodePattern = {
  regex: /^[0-9]{4}$/,
  expected: 'CFOP com 4 dígitos',
};

export const CNAE: CodePattern = {
  regex: /^[0-9]{7}$/,
  expected: 'CNAE com 7 dígitos',
};

export const RANDOM_CODE: CodePattern = {
  regex: /^[0-9]{8}$/,
  expected: 'código numérico cNF com 8 dígitos',
};

export const TAX_SITUATION_CODE: CodePattern = {
  regex: /^[0-9]{2}$/,
  expected: 'CST com 2 dígitos',
};

export const PAYMENT_METHOD: CodePattern = {
  regex: /^[0-9]{2}$/,
  expected: 'código do meio de pagamento com 2 dígitos',
};
