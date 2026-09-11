# NF-e modelo 55 — sistema de emissão

Sistema de emissão e gestão de Nota Fiscal Eletrônica modelo 55.

**Estado atual: fundação fiscal implementada e testada.** Ainda não emite NF-e
ponta a ponta. O que existe está descrito honestamente abaixo, e o que não
existe está listado como tal.

## Por que a base fiscal foi pesquisada antes de codar

A NF-e mudou de forma relevante em 2026. Implementar de memória produziria um
sistema que a SEFAZ rejeita. Os fatos abaixo foram extraídos dos **XSDs oficiais**
versionados neste repositório, não de documentação secundária:

| Fato | Evidência no schema |
|---|---|
| CNPJ passou a ser **alfanumérico** | `TCnpj` = `[0-9A-Z]{12}[0-9]{2}` |
| Chave de acesso passou a ser **alfanumérica** | `TChNFe` = `[0-9]{6}[0-9A-Z]{12}[0-9]{26}` |
| DV usa conversão `ASCII(c) − 48` | NT 2026.004 |
| Grupos da reforma tributária existem no leiaute | `IBSCBS`, `IBSCBSTot`, `IS` |
| Reforma tem 30 subgrupos | `DFeTiposBasicos_v1.00.xsd` |
| Versão do leiaute segue **4.00** | `leiauteNFe_v4.00.xsd` |

A implementação clássica com `[0-9]{44}` e `parseInt(char)` gera chave inválida
assim que um CNPJ alfanumérico entra em cena. Aqui isso é requisito coberto por
teste, não melhoria futura.

### Origem dos schemas

`schemas/nfe/PL_010f_v1.04/` — Pacote de Liberação nº 010f, publicado em
31/08/2026 pelo Portal Nacional da NF-e, contemplando NT 2025.002 v.1.50 e
NT 2026.007 v.1.00. Arquivos baixados do portal oficial, **sem modificação**.

## O que está implementado

| Módulo | Estado | Testes |
|---|---|---|
| `@nfe/core` · módulo 11 alfanumérico | pronto | 7 |
| `@nfe/core` · CNPJ alfanumérico + DV | pronto | 14 |
| `@nfe/core` · chave de acesso + DV | pronto | 12 |
| `@nfe/core` · decimal exato e rateio | pronto | 15 |
| `@nfe/core` · máquina de estados | pronto | 17 |
| `@nfe/core` · regressões de revisão | pronto | 16 |
| `@nfe/xsd` · validação contra XSD oficial | pronto | 9 |

Total: **90 testes passando**, typecheck strict limpo nos dois pacotes.

### Revisão de código de 2026-09-10

Uma revisão em dois eixos (padrões e especificação) encontrou seis defeitos reais
na primeira versão desta fundação. Todos foram reproduzidos por teste antes de
serem corrigidos; os testes ficaram como regressão em
`packages/core/tests/review-regressions.test.ts`.

| # | Defeito | Impacto |
|---|---|---|
| 1 | `allocate` estourava `RangeError` com pesos fracionários mínimos | falha crua no meio da emissão |
| 2 | resto do rateio ia para item de peso zero | item excluído recebia centavo de frete/desconto |
| 3 | AAMM da chave derivava de UTC | nota emitida após 21h no último dia do mês recebia competência errada |
| 4 | `PENDING_RECONCILIATION` alcançava `SENDING` via `CONTINGENCY` | caminho de retransmissão — NF-e duplicada |
| 5 | `times()` truncava em silêncio | perda de precisão e de sinal em produtos pequenos |
| 6 | `toScaledUnits` fixava `HalfUp` | rateio nunca conseguia usar half-even |

O defeito 4 é o mais grave: a invariante estava afirmada no comentário e no
teste, mas o teste verificava apenas a ausência da aresta direta. A garantia
agora é uma busca no grafo (`canReachTransmissionWithoutResolution`), não a
inspeção de uma aresta.

## O que NÃO está implementado

Nada disso está iniciado. Listado para que o estado do projeto não seja
superestimado:

- XML Builder (grupos `ide`, `emit`, `dest`, `det`, `total`, `transp`, `pag`)
- Assinatura digital XML-DSig e gestão de certificado A1
- `SefazProvider` (mock e real), filas, workers, reconciliação
- Persistência: Prisma, Postgres, migrations, multitenancy, RBAC
- Eventos: cancelamento, CC-e, inutilização, contingência
- DANFE
- API NestJS e frontend Next.js
- Docker Compose

## Decisões travadas

| Decisão | Valor |
|---|---|
| Estratégia | Vertical slice — emitir ponta a ponta contra mock antes de aprofundar |
| Emitente-piloto | SP / Simples Nacional (CRT=1, CSOSN) |
| Certificado | Nenhum disponível; A1 self-signed + provider real atrás de flag |

## Itens que exigem validação fiscal especializada

Nenhum destes foi chutado no código — todos são entrada parametrizável:

- alíquotas de IBS/CBS e `cClassTrib` por operação;
- tratamento de IBS/CBS para optante do Simples Nacional;
- CSOSN aplicável por combinação operação × destinatário × produto;
- prazos vigentes de cancelamento e de CC-e;
- política de arredondamento por tributo (default `HalfUp`, é decisão
  arquitetural e não regra confirmada).

## Rodando

```bash
npm install

npm run verify     # lint + typecheck + testes + build + smoke, nessa ordem
```

Ou cada etapa isolada:

```bash
npm run lint       # eslint com regras baseadas em tipos
npm run typecheck  # tsc --noEmit, strict
npm test           # 90 testes nos dois pacotes
npm run build      # emite dist/ apenas de src
npm run smoke      # exercita o dist compilado, não o source
```

`npm run smoke` existe porque build verde não prova que o artefato emitido é
utilizável — o script importa `dist/` como um consumidor real importaria, gera
uma chave de acesso com CNPJ alfanumérico, confere o rateio e valida um XML
contra o XSD oficial.

Requisitos: Node >= 22. Sem dependência de toolchain nativo — a validação XSD usa
`libxml2-wasm`, que roda no Windows sem build.

## Estrutura

```
docs/superpowers/specs/   design da fatia 1
schemas/nfe/              XSDs oficiais versionados
packages/core/            domínio fiscal puro — sem IO, sem framework
packages/xsd/             validação contra schema oficial
```

`packages/core` não importa NestJS, Prisma, HTTP nem filesystem. É a fronteira
que impede lógica fiscal de vazar para controllers e telas.
