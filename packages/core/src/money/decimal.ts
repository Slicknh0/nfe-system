/**
 * Decimal exato para valores fiscais e monetários.
 *
 * Implementado sobre `bigint` com escala explícita. Nenhum valor fiscal transita
 * por `number` em ponto flutuante: a soma dos itens tem que fechar com o total
 * da nota até o último centavo, e IEEE-754 não oferece essa garantia.
 *
 * Decisão arquitetural (não é regra fiscal confirmada): a política de
 * arredondamento default é `HalfUp`, o arredondamento comercial. A política é
 * parâmetro em toda operação que reduz escala, de modo que uma exigência
 * diferente por tributo ou por UF seja configuração e não reescrita.
 */

import { FiscalError } from '../errors.js';

export class DecimalError extends FiscalError {}

export enum RoundingMode {
  /** Empate vai para cima em módulo. Arredondamento comercial. */
  HalfUp = 'HALF_UP',
  /** Empate vai para o vizinho par. Reduz viés acumulado em somas longas. */
  HalfEven = 'HALF_EVEN',
  /** Trunca em direção a zero. */
  Truncate = 'TRUNCATE',
}

const DECIMAL_INPUT = /^-?\d+(\.\d+)?$/;

/** Escala interna de trabalho. Folgada o bastante para preço unitário da NF-e. */
const INTERNAL_SCALE = 10;

/** Precisão inteira dada ao menor peso positivo de um rateio. */
const WEIGHT_PRECISION = 1_000_000;

/**
 * Teto para a razão entre o maior e o menor peso de um rateio. Acima disso a
 * proporção deixa de ser representável e o rateio falha alto, em vez de
 * devolver parcelas silenciosamente erradas.
 */
const MAX_WEIGHT_RATIO = 1e12;

function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

function absBigInt(value: bigint): bigint {
  return value < 0n ? -value : value;
}

export class Decimal {
  /** Valor representado como inteiro escalado por `10 ** scale`. */
  private readonly units: bigint;
  private readonly scale: number;

  private constructor(units: bigint, scale: number) {
    this.units = units;
    this.scale = scale;
  }

  static readonly ZERO = new Decimal(0n, INTERNAL_SCALE);

  /**
   * Constrói a partir de string. Não existe construtor a partir de `number`
   * de propósito — aceitar `0.1` já significaria herdar o erro de representação
   * de quem chamou.
   */
  static parse(input: string): Decimal {
    if (!DECIMAL_INPUT.test(input)) {
      throw new DecimalError(
        `Valor decimal inválido: ${JSON.stringify(input)}. ` +
          `Esperado formato numérico como "0", "-12.34" ou "1234.5678".`,
      );
    }

    const negative = input.startsWith('-');
    const unsigned = negative ? input.slice(1) : input;
    const [integerPart = '0', fractionPart = ''] = unsigned.split('.');

    if (fractionPart.length > INTERNAL_SCALE) {
      throw new DecimalError(
        `Valor ${JSON.stringify(input)} excede a escala interna de ${INTERNAL_SCALE} casas.`,
      );
    }

    const padded = fractionPart.padEnd(INTERNAL_SCALE, '0');
    const magnitude = BigInt(integerPart + padded);

    return new Decimal(negative ? -magnitude : magnitude, INTERNAL_SCALE);
  }

  /** Constrói a partir de inteiro já escalado — usado na leitura do banco. */
  static fromScaledUnits(units: bigint, scale: number): Decimal {
    if (!Number.isInteger(scale) || scale < 0 || scale > INTERNAL_SCALE) {
      throw new DecimalError(`Escala inválida: ${scale}.`);
    }
    return new Decimal(units * pow10(INTERNAL_SCALE - scale), INTERNAL_SCALE);
  }

  /**
   * Inteiro escalado na escala pedida — usado na escrita no banco.
   *
   * A política de arredondamento é parâmetro: fixá-la aqui tornava impossível
   * rateio em half-even, já que `allocate` passa por este método.
   */
  toScaledUnits(scale: number, mode: RoundingMode = RoundingMode.HalfUp): bigint {
    return this.round(scale, mode).units / pow10(INTERNAL_SCALE - scale);
  }

  plus(other: Decimal): Decimal {
    return new Decimal(this.units + other.units, this.scale);
  }

  minus(other: Decimal): Decimal {
    return new Decimal(this.units - other.units, this.scale);
  }

  /**
   * Produto de dois valores escalados carrega escala dobrada e precisa voltar à
   * escala interna. Essa redução é arredondamento, não truncamento: divisão
   * inteira crua descartava a metade baixa em silêncio e chegava a zerar o
   * sinal de produtos pequenos.
   */
  times(other: Decimal, mode: RoundingMode = RoundingMode.HalfUp): Decimal {
    const raw = this.units * other.units;
    const divisor = pow10(INTERNAL_SCALE);

    const negative = raw < 0n;
    const magnitude = absBigInt(raw);
    const quotient = magnitude / divisor;
    const remainder = magnitude % divisor;

    let rounded: bigint;
    switch (mode) {
      case RoundingMode.Truncate: {
        rounded = quotient;
        break;
      }
      case RoundingMode.HalfUp: {
        rounded = remainder * 2n >= divisor ? quotient + 1n : quotient;
        break;
      }
      case RoundingMode.HalfEven: {
        const doubled = remainder * 2n;
        if (doubled > divisor) {
          rounded = quotient + 1n;
        } else if (doubled < divisor) {
          rounded = quotient;
        } else {
          rounded = quotient % 2n === 0n ? quotient : quotient + 1n;
        }
        break;
      }
      default: {
        throw new DecimalError(`Política de arredondamento desconhecida: ${String(mode)}.`);
      }
    }

    return new Decimal(negative ? -rounded : rounded, INTERNAL_SCALE);
  }

  negated(): Decimal {
    return new Decimal(-this.units, this.scale);
  }

  isZero(): boolean {
    return this.units === 0n;
  }

  isNegative(): boolean {
    return this.units < 0n;
  }

  equals(other: Decimal): boolean {
    return this.units === other.units;
  }

  isGreaterThan(other: Decimal): boolean {
    return this.units > other.units;
  }

  isLessThan(other: Decimal): boolean {
    return this.units < other.units;
  }

  /** Reduz para `targetScale` aplicando a política informada. */
  round(targetScale: number, mode: RoundingMode = RoundingMode.HalfUp): Decimal {
    if (!Number.isInteger(targetScale) || targetScale < 0 || targetScale > INTERNAL_SCALE) {
      throw new DecimalError(`Escala alvo inválida: ${targetScale}.`);
    }

    const divisor = pow10(INTERNAL_SCALE - targetScale);
    if (divisor === 1n) {
      return this;
    }

    const negative = this.units < 0n;
    const magnitude = absBigInt(this.units);
    const quotient = magnitude / divisor;
    const remainder = magnitude % divisor;

    let rounded: bigint;
    switch (mode) {
      case RoundingMode.Truncate: {
        rounded = quotient;
        break;
      }
      case RoundingMode.HalfUp: {
        rounded = remainder * 2n >= divisor ? quotient + 1n : quotient;
        break;
      }
      case RoundingMode.HalfEven: {
        const doubled = remainder * 2n;
        if (doubled > divisor) {
          rounded = quotient + 1n;
        } else if (doubled < divisor) {
          rounded = quotient;
        } else {
          rounded = quotient % 2n === 0n ? quotient : quotient + 1n;
        }
        break;
      }
      default: {
        throw new DecimalError(`Política de arredondamento desconhecida: ${String(mode)}.`);
      }
    }

    const scaled = rounded * divisor;
    return new Decimal(negative ? -scaled : scaled, INTERNAL_SCALE);
  }

  /** Representação com escala fixa, pronta para o XML. */
  toFixed(scale: number, mode: RoundingMode = RoundingMode.HalfUp): string {
    const rounded = this.round(scale, mode);
    const divisor = pow10(INTERNAL_SCALE);
    const negative = rounded.units < 0n;
    const magnitude = absBigInt(rounded.units);

    const integerPart = magnitude / divisor;
    const fractionPart = (magnitude % divisor).toString().padStart(INTERNAL_SCALE, '0');
    const trimmed = scale === 0 ? '' : `.${fractionPart.slice(0, scale)}`;

    return `${negative && (integerPart !== 0n || trimmed.replace(/[.0]/g, '') !== '') ? '-' : ''}${integerPart}${trimmed}`;
  }

  /** Forma canônica sem zeros à direita — para logs e mensagens. */
  toString(): string {
    const negative = this.units < 0n;
    const magnitude = absBigInt(this.units);
    const divisor = pow10(INTERNAL_SCALE);
    const integerPart = magnitude / divisor;
    const fractionPart = (magnitude % divisor)
      .toString()
      .padStart(INTERNAL_SCALE, '0')
      .replace(/0+$/, '');

    const body = fractionPart === '' ? `${integerPart}` : `${integerPart}.${fractionPart}`;
    return negative && this.units !== 0n ? `-${body}` : body;
  }
}

/**
 * Rateia um total entre pesos, garantindo que a soma das partes é exatamente o
 * total. O resto de divisão é distribuído unidade a unidade nas primeiras
 * partes, em vez de arredondar cada parcela isoladamente — arredondar item a
 * item é o que produz a diferença de centavos que a SEFAZ rejeita.
 */
export function allocate(
  total: Decimal,
  weights: readonly number[],
  scale: number,
  mode: RoundingMode = RoundingMode.HalfUp,
): Decimal[] {
  if (weights.length === 0) {
    throw new DecimalError('Rateio exige ao menos um peso.');
  }

  if (weights.some((weight) => !Number.isFinite(weight) || weight < 0)) {
    throw new DecimalError('Pesos de rateio devem ser números não negativos.');
  }

  const positiveWeights = weights.filter((weight) => weight > 0);
  if (positiveWeights.length === 0) {
    throw new DecimalError('Soma dos pesos de rateio deve ser maior que zero.');
  }

  // Os pesos são normalizados pelo menor peso positivo antes de virarem
  // inteiros. Escalar por um fator fixo achatava pesos fracionários mínimos
  // para zero, e a soma zerada estourava divisão por zero já dentro da emissão.
  const smallestWeight = Math.min(...positiveWeights);
  const largestWeight = Math.max(...positiveWeights);
  if (largestWeight / smallestWeight > MAX_WEIGHT_RATIO) {
    throw new DecimalError(
      `Razão entre o maior e o menor peso do rateio excede ${MAX_WEIGHT_RATIO}; ` +
        `a proporção não é representável com precisão suficiente.`,
    );
  }

  const weightUnits = weights.map((weight) =>
    weight <= 0 ? 0n : BigInt(Math.round((weight / smallestWeight) * WEIGHT_PRECISION)),
  );
  const totalWeightUnits = weightUnits.reduce((sum, weight) => sum + weight, 0n);
  if (totalWeightUnits === 0n) {
    throw new DecimalError('Pesos de rateio degeneraram para zero na conversão.');
  }

  // O rateio fecha com o total já reduzido à escala de saída. Um total com mais
  // casas que `scale` não é representável na soma das partes, e forçar isso
  // produziria parcelas que não somam o valor impresso na nota.
  const totalUnits = total.toScaledUnits(scale, mode);

  const parts = weightUnits.map((weight) => (totalUnits * weight) / totalWeightUnits);
  const distributed = parts.reduce((sum, part) => sum + part, 0n);
  let remainder = totalUnits - distributed;

  // O resto vai apenas para partes que participam do rateio. Distribuí-lo a
  // partir do índice zero dava centavo de frete ou desconto a item que fora
  // deliberadamente excluído.
  const eligible = parts
    .map((_, index) => index)
    .filter((index) => (weightUnits[index] ?? 0n) > 0n);

  const step = remainder >= 0n ? 1n : -1n;
  for (let cursor = 0; remainder !== 0n; cursor = (cursor + 1) % eligible.length) {
    const index = eligible[cursor];
    if (index === undefined) {
      throw new DecimalError('Falha ao distribuir o resto do rateio.');
    }
    parts[index] = (parts[index] ?? 0n) + step;
    remainder -= step;
  }

  return parts.map((units) => Decimal.fromScaledUnits(units, scale));
}
