/**
 * Garante em tempo de compilação que toda variante de uma união foi tratada.
 *
 * Quando uma variante nova é acrescentada — um grupo de ICMS, por exemplo — o
 * compilador aponta cada `switch` que ainda não a trata, em vez de o código
 * seguir por um caminho padrão silencioso.
 */
export function assertNever(value: never): never {
  throw new Error(`Variante não tratada: ${JSON.stringify(value)}.`);
}
