# NF-e modelo 55 — sistema de emissão

Sistema de emissão e gestão de Nota Fiscal Eletrônica modelo 55.

**Estado atual:** o núcleo monta o XML da NF-e, assina com XML-DSig, e o
resultado passa na validação contra o XSD oficial — verificado também por uma
implementação de assinatura independente. Ainda não há persistência,
comunicação com a SEFAZ, API nem interface. O que existe e o que não existe
está descrito abaixo, sem arredondar para cima.

## Por que a base fiscal foi pesquisada antes de codar

A NF-e mudou de forma relevante em 2026. Implementar de memória produziria um
sistema que a SEFAZ rejeita. Os fatos abaixo foram extraídos dos **XSDs oficiais**
versionados neste repositório, não de documentação secundária:

| Fato | Evidência no schema |
|---|---|
| CNPJ passou a ser **alfanumérico** | `TCnpj` = `[0-9A-Z]{12}[0-9]{2}` |
| Chave de acesso passou a ser **alfanumérica** | `TChNFe` = `[0-9]{6}[0-9A-Z]{12}[0-9]{26}` |
| DV usa conversão `ASCII(c) − 48` | NT 2026.004 |
| Grupos da reforma tributária existem, e são opcionais no schema | `IBSCBS`, `IBSCBSTot`, `IS` com `minOccurs="0"` |
| Assinatura é obrigatória no documento | `<xs:element ref="ds:Signature"/>` em `TNFe` |
| Algoritmos de assinatura são fixos | `xmldsig-core-schema_v1.01.xsd`: C14N 1.0, RSA-SHA1, SHA1 |
| Texto só aceita U+0020 a U+00FF | `TString` = `[!-ÿ]{1}[ -ÿ]{0,}[!-ÿ]{1}` |
| Versão do leiaute segue **4.00** | `TVerNFe` = `4\.00` |

E da documentação oficial, lida na íntegra:

| Fato | Fonte |
|---|---|
| IBS/CBS/IS para Simples Nacional só a partir de 2027; NT para CRT=1 ainda não publicada | NT 2025.002 v1.51, cronograma |
| Contingência vigente: FS-DA, EPEC, SVC; SCAN desativado; offline só NFC-e | MOC 7.0, Anexos I e III |
| SP usa SVC-AN como contingência | Portal Nacional, disponibilidade |

### Origem dos schemas

`schemas/nfe/PL_010f_v1.04/` — Pacote de Liberação nº 010f, publicado em
31/08/2026 pelo Portal Nacional da NF-e, contemplando NT 2025.002 v.1.50 e
NT 2026.007 v.1.00. Arquivos baixados do portal oficial, **sem modificação**.

## O que está implementado

| Pacote | Conteúdo | Testes |
|---|---|---|
| `@nfe/core` | módulo 11 alfanumérico, CNPJ, CPF, GTIN | 31 |
| `@nfe/core` | chave de acesso | 12 |
| `@nfe/core` | decimal exato e rateio | 15 |
| `@nfe/core` | máquina de estados | 17 |
| `@nfe/core` | XML Builder: árvore XML, texto fiscal, formatos, totais, montagem | 62 |
| `@nfe/core` | regressões da revisão de código | 16 |
| `@nfe/xsd` | validação contra o XSD oficial | 9 |
| `@nfe/signer` | assinatura XML-DSig e verificação | 14 |
| `@nfe/signer` | pipeline montar → assinar → XSD oficial → verificação independente | 12 |

Total: **188 testes**. Lint, typecheck strict e build limpos.

### Prova ponta a ponta

`packages/signer/tests/pipeline.integration.test.ts` monta, assina e valida
contra o XSD oficial cinco cenários, e confere cada assinatura também com
`xml-crypto`, uma implementação de XML-DSig que não compartilha código com a
deste sistema:

1. documento de referência: SP, Simples Nacional, consumidor pessoa física;
2. destinatário contribuinte com CNPJ alfanumérico e inscrição estadual;
3. emitente com CNPJ alfanumérico;
4. vários itens com desconto, frete, seguro, GTIN, CEST, PIS por alíquota e
   COFINS não tributado, duas formas de pagamento, `infAdic` e `infRespTec`;
5. contingência SVC-AN, com `dhCont` e `xJust`.

Os controles negativos também estão lá: XML sem assinatura é rejeitado pelo
XSD, e alterar um valor depois de assinar é detectado pelas duas verificações.

## Decisões da fatia do XML Builder

Tomadas depois de pesquisa em fonte oficial e comparação com a implementação de
referência sped-nfe (NFePHP).

| # | Decisão | Motivo |
|---|---|---|
| Q1 | XML Builder + assinatura antes da persistência | domínio puro, testável sem infraestrutura, e fecha um ciclo verificável contra o XSD |
| Q2 | Núcleo sem IBS/CBS/IS, com posição reservada | para CRT=1 a tributação começa em 2027 e a NT ainda não existe |
| Q3 | Numeração: `SELECT … FOR UPDATE`, número consumido na assinatura | adiada para a fatia com banco |
| Q4 | Acesso a dados: Drizzle | adiada para a fatia com banco |
| Q5 | Contingência: normal e SVC-AN estruturalmente prontas; EPEC em fatia própria | SVC muda o endpoint, não o XML; EPEC é fluxo próprio |
| Q6 | `tpEmis` aceitos: 1, 4, 5, 6, 7 | 2 é legado, 3 tem divergência entre documentos oficiais, 9 é só NFC-e |

### Decisões de implementação

- **Serializador XML próprio**, pequeno e testado, em vez de biblioteca genérica:
  saída compacta, ordem de construção preservada e recusa de caractere inválido
  no momento da montagem.
- **Texto fiscal não é "consertado" em silêncio.** Espaços nas bordas são
  removidos; qualquer caractere fora de U+0020–U+00FF é recusado apontando o
  campo. Trocar "—" por "-" alteraria o que o contribuinte escreveu.
- **Serializar não arredonda.** Valor com mais casas do que o campo admite é
  recusado: o arredondamento pertence ao cálculo.
- **`vProd` sem arredondamento duplo.** O produto quantidade × preço pode ter 14
  casas; reduzir em duas etapas com `HalfUp` transforma 0,00499999999999 em
  0,01. A etapa intermediária trunca, o que é exato para `HalfUp`.
- **Assinatura com libxml2 + `node:crypto`**, sem biblioteca de XML-DSig: o
  schema fixa um único conjunto de algoritmos, e usar o mesmo parser do
  validador evita divergência de canonicalização. `xml-crypto` entra apenas
  como verificador independente nos testes.
- **`@nfe/signer` não depende de `@nfe/core`.** A classificação da falha em erro
  fiscal ou técnico acontece na camada de aplicação, a partir de um `reason`
  estável.

## O que NÃO está implementado

- persistência, multitenancy, RBAC e numeração concorrente;
- `SefazProvider` (mock e real), filas, workers e reconciliação;
- certificado A1: leitura de PFX, armazenamento cifrado, validação de cadeia
  ICP-Brasil (o signer recebe chave e certificado em PEM);
- eventos (cancelamento, CC-e, inutilização) e EPEC;
- DANFE, API NestJS, frontend Next.js, Docker Compose;
- IBS, CBS e IS;
- grupos fora do escopo do builder: ICMS do regime normal (CST), substituição
  tributária, IPI, II, ISSQN, destinatário estrangeiro, item fora do total
  (`indTot = 0`), unidade tributável diferente da comercial, grupo `card`,
  transportadora e volumes, cobrança.

## Revisão de código de 2026-09-10

Uma revisão em dois eixos (padrões e especificação) encontrou seis defeitos reais
na primeira versão da fundação. Todos foram reproduzidos por teste antes de
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
agora é uma busca no grafo (`canReachTransmissionWithoutResolution`).

## Itens que exigem validação fiscal especializada

Nenhum destes foi chutado no código — ou são parâmetro, ou estão
deliberadamente fora:

- alíquotas de IBS/CBS e `cClassTrib` por operação;
- CST de PIS e COFINS aplicável a cada operação do Simples Nacional (os testes
  usam valores ilustrativos);
- CSOSN aplicável por combinação operação × destinatário × produto;
- fórmula do `vNF`: extraída da implementação de referência sped-nfe, ainda não
  conferida contra o texto da regra de validação no MOC;
- prazos vigentes de cancelamento e de CC-e;
- política de arredondamento por tributo (default `HalfUp`, decisão
  arquitetural);
- regras de validação da SEFAZ que o XSD não expressa e que **não** foram
  implementadas por falta de confirmação em fonte oficial nesta fatia: razão
  social do destinatário em homologação, `indIntermed` conforme `indPres`, grupo
  `card` para pagamento com cartão, `cNF` diferente de `nNF`, obrigatoriedade de
  `infRespTec` em SP;
- `tpEmis = 3`: SCAN desativado no Anexo I do MOC, "NFF" nas regras de validação
  das NTs vigentes.

## Rodando

```bash
npm install

npm run verify     # lint + typecheck + testes + build + smoke, nessa ordem
```

Ou cada etapa isolada:

```bash
npm run lint       # eslint com regras baseadas em tipos
npm run typecheck  # tsc --noEmit, strict
npm test           # 188 testes nos três pacotes
npm run build      # emite dist/ apenas de src
npm run smoke      # exercita o dist compilado, não o source
```

`npm run smoke` existe porque build verde não prova que o artefato emitido é
utilizável. O script importa `dist/` como um consumidor real importaria e
percorre o pipeline inteiro: gera a chave com CNPJ alfanumérico, monta o XML,
assina com um certificado autoassinado criado em memória, valida contra o XSD
oficial e confere que uma alteração posterior à assinatura é detectada.

Requisitos: Node >= 22. Sem toolchain nativo — validação XSD e canonicalização
usam `libxml2-wasm`.

## Estrutura

```
docs/superpowers/specs/   design da fatia 1
schemas/nfe/              XSDs oficiais versionados
packages/core/            domínio fiscal puro — sem IO, sem framework
  src/fiscal/             módulo 11, CNPJ, CPF, GTIN, chave de acesso
  src/money/              decimal exato e rateio
  src/nfe/                modelo do documento, totais, máquina de estados
  src/nfe/xml/            XML Builder, um arquivo por grupo do leiaute
  src/xml/                árvore XML e serializador
packages/xsd/             validação contra o XSD oficial
packages/signer/          assinatura XML-DSig e verificação
scripts/smoke.mjs         smoke test sobre os pacotes compilados
```

`packages/core` não importa NestJS, Prisma, HTTP nem filesystem. É a fronteira
que impede lógica fiscal de vazar para controllers e telas.
