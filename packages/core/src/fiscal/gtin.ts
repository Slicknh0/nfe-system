/**
 * GTIN (código de barras do produto) — campos `cEAN` e `cEANTrib`.
 *
 * O XSD aceita `SEM GTIN`, vazio, 8 dígitos ou de 12 a 14 dígitos. O dígito
 * verificador segue o algoritmo GS1 (módulo 10, pesos 3 e 1 alternados a partir
 * da direita). Conferir o DV localmente evita rejeição por GTIN com erro de
 * digitação, que o schema sozinho não pega.
 */

const GTIN_PATTERN = /^(?:[0-9]{8}|[0-9]{12,14})$/;

/** Literal exigido pelo leiaute quando o produto não tem GTIN. */
export const WITHOUT_GTIN = 'SEM GTIN';

export function isValidGtin(value: string): boolean {
  if (!GTIN_PATTERN.test(value)) {
    return false;
  }

  const body = value.slice(0, -1);
  const informed = Number(value.slice(-1));

  let sum = 0;
  for (let offset = 0; offset < body.length; offset += 1) {
    const digit = Number(body[body.length - 1 - offset]);
    sum += digit * (offset % 2 === 0 ? 3 : 1);
  }

  return (10 - (sum % 10)) % 10 === informed;
}
