# NF-e modelo 55 — Design (fatia 1: vertical slice)

Data: 2026-09-10
Status: aprovado para implementação

## 1. Decisões travadas com o solicitante

| Decisão | Valor | Consequência |
|---|---|---|
| Estratégia de entrega | Vertical slice | Fatia 1 emite NF-e ponta a ponta contra SEFAZ **mock** |
| Emitente-piloto | SP / Simples Nacional (CRT=1) | CSOSN em vez de CST-ICMS; autorizador próprio SEFAZ-SP |
| Certificado | Nenhum disponível | A1 self-signed gerado por script; provider real atrás de feature flag |

## 2. Base fiscal — CONFIRMADA em fonte oficial

Fonte primária: Portal Nacional da NF-e, **Pacote de Liberação nº 010f (PL_010f_v1.04)**,
publicado em 31/08/2026, contendo NT 2025.002 v.1.50 e NT 2026.007 v.1.00.
Os XSDs estão versionados em `schemas/nfe/PL_010f_v1.04/` — baixados do portal oficial,
não transcritos.

### 2.1 Fatos extraídos do XSD (não de memória, não de blog)

| Fato | Evidência |
|---|---|
| Versão do leiaute segue **4.00** | `leiauteNFe_v4.00.xsd`, atributo `versao` tipo `TVerNFe` |
| CNPJ é **alfanumérico** | `TCnpj` = `xs:string` pattern `[0-9A-Z]{12}[0-9]{2}` |
| Chave de acesso é **alfanumérica** | `TChNFe` pattern `[0-9]{6}[0-9A-Z]{12}[0-9]{26}` |
| CPF continua numérico | `TCpf` pattern `[0-9]{11}` |
| IE aceita literal | `TIe` pattern `[0-9]{2,14}|ISENTO` |
| Grupos da reforma existem no item e no total | `IBSCBS`, `IBSCBSTot`, `IS` |
| Reforma tem 30 subgrupos | `DFeTiposBasicos_v1.00.xsd`: `gIBSCBS`, `gIBS`, `gIBSUF`, `gIBSMun`, `gCBS`, `gTribRegular`, `gRed`, `gDif`, `gMono*`, `gCredPres*`, `gTribCompraGov`, … |

### 2.2 Decomposição da chave de acesso (derivada do pattern oficial)

```
posições  1- 2  cUF      2 numéricos    ─┐
posições  3- 6  AAMM     4 numéricos    ─┴─ [0-9]{6}
posições  7-18  CNPJ     12 alfanum     ─── [0-9A-Z]{12}
posições 19-20  DV CNPJ   2 numéricos   ─┐
posições 21-22  mod       2 numéricos    │
posições 23-25  série     3 numéricos    │
posições 26-34  nNF       9 numéricos    ├─ [0-9]{26}
posição  35     tpEmis    1 numérico     │
posições 36-43  cNF       8 numéricos    │
posição  44     cDV       1 numérico    ─┘
```
Soma: 6 + 12 + 26 = 44. Confere com `TChNFe`.

### 2.3 Dígito verificador com CNPJ alfanumérico — NT 2026.004

Módulo 11 sobre os 43 primeiros caracteres, onde o valor numérico de cada caractere é
`ASCII(c) - 48`. Para dígitos `'0'..'9'` isso devolve 0..9 (compatível com o algoritmo
antigo); para `'A'..'Z'` devolve 17..42.

**Implicação de engenharia:** a implementação clássica `parseInt(char)` produz chave
inválida assim que o emitente ou destinatário tiver CNPJ alfanumérico. Tratado como
requisito, não como melhoria futura.

### 2.4 Endpoints SEFAZ-SP (confirmados no portal da SEFAZ-SP)

Homologação: `https://homologacao.nfe.fazenda.sp.gov.br/ws/<serviço>.asmx`
Produção:    `https://nfe.fazenda.sp.gov.br/ws/<serviço>.asmx`

Serviços: `nfeautorizacao4`, `nferetautorizacao4`, `nfeconsultaprotocolo4`,
`nfestatusservico4`, `nferecepcaoevento4`, `nfeinutilizacao4`.

Nunca hardcoded no domínio — vivem em catálogo versionado (`sefaz_endpoints`),
resolvidos por (UF, ambiente, serviço, versão).

### 2.5 Fronteira explícita do que NÃO está confirmado

Itens que exigem validação fiscal especializada antes de produção, e que ficam
**parametrizáveis** em vez de chutados:

- Alíquotas de IBS/CBS e regras de `cClassTrib` por operação.
- Tratamento de IBS/CBS para optante do Simples Nacional.
- Regra de CSOSN aplicável por combinação (operação × destinatário × produto).
- Prazo vigente de cancelamento e de CC-e.

Nenhum desses é inventado no código. Cada um é entrada do motor fiscal, com o valor
default vindo de configuração e não de constante embutida.

## 3. Arquitetura

```
apps/web (Next.js)  ──HTTP──>  apps/api (NestJS)  ──> packages/core (domínio puro)
                                      │                        │
                                      ├──> Postgres (Prisma)    ├── money/
                                      ├──> Redis + BullMQ       ├── access-key/
                                      │        │                ├── cnpj/
                                      │        v                ├── state-machine/
                                      │   apps/worker           ├── xml-builder/
                                      ├──> MinIO (S3)           ├── xsd/
                                      └──> audit log            └── tax-engine/
                                                                     │
                                              packages/sefaz ────────┘
                                              (SefazProvider: mock | real)
```

`packages/core` não importa NestJS, Prisma, HTTP nem filesystem de aplicação.
É domínio puro, testável sem container. Essa é a regra que impede lógica fiscal
espalhada (seção 4 do brief).

## 4. Precisão monetária

Nada de `number` para dinheiro. Tipo `Decimal` sobre inteiro escalado
(`bigint`, escala fixa de 10 casas), com política de arredondamento **explícita e
parametrizada em toda operação que reduz escala** — `round`, `toFixed`, `times`,
`toScaledUnits` e `allocate`.

O default é `HalfUp` (arredondamento comercial). **Isso é decisão arquitetural,
não regra fiscal confirmada** — por isso é parâmetro, e não constante. Uma
exigência diferente por tributo ou por UF é configuração, não reescrita.

> Revisão de 2026-09-10: uma versão anterior deste documento afirmava
> "arredondamento half-even". O código sempre usou `HalfUp` como default. A
> divergência foi resolvida a favor do código, e a política virou parâmetro
> alcançável a partir do rateio — antes `toScaledUnits` fixava `HalfUp`
> internamente, o que tornava half-even inalcançável justamente na operação em
> que mais importa.

Rateio de desconto/frete usa distribuição com resto, garantindo que a soma dos
itens fecha exatamente com o total da nota — a fonte clássica de rejeição. O
resto é distribuído apenas entre parcelas de peso não nulo.

## 5. Máquina de estados

```
DRAFT → VALIDATING → VALIDATED → SIGNED → QUEUED → SENDING → PROCESSING → AUTHORIZED
```
Ramos: `LOCAL_VALIDATION_ERROR`, `REJECTED`, `COMMUNICATION_ERROR`,
`PENDING_RECONCILIATION`, `DENIED`, `CANCELLED`, `CONTINGENCY`.

Transições declaradas como dado, não como `if`. `AUTHORIZED` é terminal para edição:
não existe aresta de volta para `DRAFT`.

## 6. Idempotência (o requisito mais crítico)

Cenário de referência: NF-e transmitida → SEFAZ autoriza → conexão cai → sistema não
recebe resposta.

Regra: **nunca retransmitir autorização às cegas.** Em timeout o documento vai para
`PENDING_RECONCILIATION` e o caminho de saída é *consulta* (por recibo ou por chave),
nunca reenvio. Reforçado por:
- idempotency key por tentativa de emissão;
- unique constraint `(company_id, model, série, número)`;
- número obtido por sequência transacional com lock — jamais `MAX(numero)+1`.

## 7. Erro fiscal ≠ erro técnico

Duas hierarquias de erro separadas desde o tipo. Rejeição da SEFAZ é resposta de
negócio (documento tem destino definido); timeout/TLS/DNS é falha de infraestrutura
(documento fica pendente de reconciliação). A UI trata as duas de forma diferente
porque a ação do usuário é diferente.

## 8. Escopo da fatia 1

Entra: núcleo fiscal testado (money, CNPJ alfanumérico, chave+DV, state machine),
validação XSD contra os schemas oficiais, assinatura XML, provider mock, persistência,
telas do fluxo principal.

Não entra (fatias seguintes): provider SEFAZ real ligado, CC-e, inutilização,
contingência, DANFE definitivo, motor IBS/CBS completo.
