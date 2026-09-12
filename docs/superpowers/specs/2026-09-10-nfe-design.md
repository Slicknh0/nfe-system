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
                                      ├──> Postgres (Drizzle)   ├── money/
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

## 9. Fatia 2 — persistência, numeração e ciclo de autorização (2026-09-12)

### 9.1 Base oficial consultada

| Fato | Fonte |
|---|---|
| `cStat` 100/150 autorizam; 110 e 301–303 denegam (tabela fechada) | MOC 7.0, Anexo I, 4.4.1 e 4.4.3 |
| Rejeições: 142 e faixa 2xx–9xx | MOC 7.0, Anexo I, 4.4.2 |
| 204 duplicidade; 539 duplicidade com diferença na chave | MOC 7.0, Anexo I, regras de validação |
| 217 "NF-e não consta na base de dados da SEFAZ" na consulta | MOC 7.0, Visão Geral, 5.4.4, regra J03 |
| 103/105 lote em processamento; 108/109 serviço paralisado | MOC 7.0, Anexo I, 4.4.1; Visão Geral, 5.2.5 |
| Síncrono (`indSinc=1`) só com uma NF-e no lote | MOC 7.0, Visão Geral, 5.1.1 |
| "NF-e Pendentes de Retorno" podem não ter chegado, estar na fila ou já estar autorizadas; recebem novo número se emitidas em contingência; as não autorizadas têm a numeração inutilizada | MOC 7.0, Anexo III, 2.3.3 |
| `nProt` (`TProt`) tem 15 ou 17 dígitos | `tiposBasico_v4.00.xsd` |

### 9.2 Decisões

| # | Decisão | Motivo |
|---|---|---|
| D1 | Número consumido na mesma transação que grava o XML assinado e válido no XSD | falha de montagem, assinatura ou XSD não queima número |
| D2 | Documento travado antes da sequência, sempre nessa ordem | emissões concorrentes não entram em deadlock |
| D3 | Tentativa de comunicação gravada ANTES da chamada à SEFAZ | queda do processo deixa rastro recuperável |
| D4 | Desfecho desconhecido (timeout, duplicidade, código não reconhecido, protocolo de outra chave) vai para `PENDING_RECONCILIATION` | confirmado pelo Anexo III, 2.3.3 |
| D5 | Nova aresta `SENDING → QUEUED` apenas para falha comprovadamente anterior ao envio ou 108/109 | nada foi processado; o mesmo XML volta à fila |
| D6 | Consulta com 217 mantém a pendência | 217 não prova que a nota não esteja na fila da SEFAZ |
| D7 | Rejeição normal mantém o número ao reemitir | a nota rejeitada não existe na SEFAZ; a proibição do Anexo III refere-se às pendentes de retorno |
| D8 | Migrations SQL próprias com checksum, Drizzle só para consultas | triggers e RLS ficam revisáveis como SQL; um teste compara o mapeamento com o banco |
| D9 | Invariantes fiscais também em trigger (SQLSTATE `NFE01`–`NFE06`) | defesa contra defeito de aplicação e SQL manual |
| D10 | RLS com `FORCE` e papel da aplicação sem superusuário nem `BYPASSRLS`, verificado na inicialização | isolamento entre tenants não depende de cada consulta lembrar o filtro |
| D11 | Postgres real nos testes via `embedded-postgres`, sem Docker | o daemon Docker não estava disponível nesta máquina |
| D12 | Provider SOAP da SEFAZ explicitamente não implementado; mock recusa produção | sem certificado A1 e sem credenciamento em homologação |

## 10. Fatia 3 — inutilização de numeração e política de reconciliação (2026-09-12)

### 10.1 Base oficial consultada

| Fato | Fonte |
|---|---|
| Serviço `nfeInutilizacao`, síncrono; pedido `inutNFe` assinado sobre `infInut` | MOC 7.0, Visão Geral, 5.3.1 a 5.3.3 |
| `Id` = "ID" + cUF + ano + CNPJ + modelo + série + nNFIni + nNFFin (43 posições) | MOC 7.0, Visão Geral, tabela 5-9; pattern `ID[0-9]{4}[0-9A-Z]{12}[0-9]{25}` em `leiauteInutNFe_v4.00.xsd` |
| `xJust` de 15 a 255 caracteres; `ano` com 2 dígitos | `TJust` e `Tano` em `tiposBasico_v4.00.xsd` |
| 102 homologa; resposta traz `nProt` e `dhRecbto` | MOC 7.0, Visão Geral, 5.3.2 e 5.3.5 |
| Regras: 453/454 (ano), 224 (faixa invertida), 201 (mais de 10.000 números), 502 (Id divergente) | MOC 7.0, Visão Geral, 5.3.4, regras I02b a I04.a |
| 563 pedido com a mesma faixa; a resposta traz o `nProt` do pedido anterior | regra I07 e 5.3.5 (NT 2015.002) |
| 256 número da faixa já inutilizado; 241 número da faixa já utilizado | regras I07a e I08 |
| 206 autorização de NF-e com número inutilizado | MOC 7.0, Anexo I, 4.4.2 |
| Pendentes de retorno não autorizadas nem denegadas têm a numeração inutilizada | MOC 7.0, Anexo III, 2.3.3 |
| Consulta repetida em looping é consumo indevido | MOC 7.0, Visão Geral, tabela 4-9 |

Os schemas de inutilização não estão no PL_010f. O pacote mais recente que os
publica é o **PL_010d_v1.03** (CNPJ alfanumérico), versionado sem modificação em
`schemas/nfe/PL_010d_v1.03/`. `tiposBasico_v4.00.xsd` e
`xmldsig-core-schema_v1.01.xsd` são idênticos byte a byte nos dois pacotes.

Nenhum pacote 010 publica o arquivo raiz `inutNFe_v4.00.xsd` citado no MOC: o
leiaute declara `TInutNFe` e só o usa dentro de `ProcInutNFe`. A validação usa
uma raiz montada em memória que apenas declara `<xs:element name="inutNFe"
type="TInutNFe"/>` sobre o leiaute oficial.

### 10.2 Decisões

| # | Decisão | Motivo |
|---|---|---|
| D13 | Novo estado terminal `NUMBER_VOIDED`, alcançável de `PENDING_RECONCILIATION`, `REJECTED`, `LOCAL_VALIDATION_ERROR` e `DRAFT` (este só com número) | fecha o ciclo das pendentes de retorno sem abrir caminho de retransmissão |
| D14 | Inutilização por documento, sempre de um único número, com os campos lidos da própria chave de acesso | recai exatamente sobre o número que foi ou pode ter sido transmitido |
| D15 | Ano da inutilização = ano da chave de acesso | decisão arquitetural; o MOC não define qual ano usar, e a regra I08 não usa o ano |
| D16 | 241 mantém a pendência; a consulta decide | a SEFAZ é o árbitro: se a nota foi processada, ela não inutiliza |
| D17 | 563 com `nProt` conta como inutilização confirmada; sem `nProt`, não | a NT 2015.002 garante o protocolo anterior na resposta |
| D18 | 256 conta como inutilizado porque o pedido cobre um único número | "uma NF-e da faixa já inutilizada" só pode ser este número |
| D19 | Política de reconciliação parametrizada: 1 min até a primeira consulta, intervalos de 2, 5, 15, 30 e 60 min, 3 consultas com 217 e 60 min desde o envio para liberar a inutilização | valores são decisão arquitetural, não regra oficial; espaçamento crescente evita consumo indevido |
| D20 | O ciclo de reconciliação consulta e aponta, mas não inutiliza sozinho | inutilização é ato fiscal e exige chamada explícita |
| D21 | Pedido de inutilização e protocolo guardados em `number_voids`, imutáveis após homologação (SQLSTATE `NFE07`) | são a prova da inutilização |
