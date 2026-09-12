# NF-e modelo 55 — sistema de emissão

Sistema de emissão e gestão de Nota Fiscal Eletrônica modelo 55.

**Estado atual:** o núcleo monta o XML da NF-e, assina com XML-DSig e valida
contra o XSD oficial. A camada de aplicação emite com numeração concorrente
sem repetição, grava tudo em Postgres com isolamento por tenant e conduz o
ciclo de autorização — incluindo timeout, reconciliação por consulta e
inutilização da numeração das notas pendentes de retorno — contra uma SEFAZ
**simulada**. Ainda não há comunicação SOAP com a SEFAZ real, API HTTP nem
interface. O que existe e o que não existe está descrito abaixo, sem arredondar
para cima.

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
| Número de protocolo tem 15 ou 17 dígitos | `TProt` = `[0-9]{15}\|[0-9]{17}` |
| Versão do leiaute segue **4.00** | `TVerNFe` = `4\.00` |

E da documentação oficial, lida na íntegra:

| Fato | Fonte |
|---|---|
| IBS/CBS/IS para Simples Nacional só a partir de 2027; NT para CRT=1 ainda não publicada | NT 2025.002 v1.51, cronograma |
| Contingência vigente: FS-DA, EPEC, SVC; SCAN desativado; offline só NFC-e | MOC 7.0, Anexos I e III |
| SP usa SVC-AN como contingência | Portal Nacional, disponibilidade |
| Autorização: 100 e 150. Denegação: 110 e a tabela fechada 301–303 | MOC 7.0, Anexo I, 4.4.1 e 4.4.3 |
| Rejeição: 142 e a faixa 2xx–9xx; 204 e 539 são duplicidade | MOC 7.0, Anexo I, 4.4.2 |
| Consulta devolve 217 quando a NF-e não consta na base | MOC 7.0, Visão Geral, 5.4.4 (J03) |
| NF-e Pendente de Retorno pode não ter chegado, estar na fila ou já estar autorizada; se não autorizada nem denegada, tem a numeração inutilizada | MOC 7.0, Anexo III, 2.3.3 |
| Inutilização: `Id` de 43 posições, justificativa de 15 a 255 caracteres, até 10.000 números por pedido | MOC 7.0, Visão Geral, 5.3; `leiauteInutNFe_v4.00.xsd` |
| Inutilização: 102 homologa; 241 número já utilizado; 256 já inutilizado; 563 pedido repetido, com o protocolo anterior | MOC 7.0, Visão Geral, 5.3.4 e 5.3.5 |
| Consulta repetida em looping é consumo indevido | MOC 7.0, Visão Geral, tabela 4-9 |

### Origem dos schemas

`schemas/nfe/PL_010f_v1.04/` — Pacote de Liberação nº 010f, publicado em
31/08/2026 pelo Portal Nacional da NF-e, contemplando NT 2025.002 v.1.50 e
NT 2026.007 v.1.00. Arquivos baixados do portal oficial, **sem modificação**.

`schemas/nfe/PL_010d_v1.03/` — Pacote de Liberação 010d v1.03 (CNPJ alfanumérico,
NT 2026.004 v1.01), publicado em 10/07/2026. É o pacote mais recente que traz os
schemas de inutilização, ausentes no PL_010f. Também sem modificação.

Nenhum pacote 010 publica o arquivo raiz `inutNFe_v4.00.xsd` citado no MOC: o
leiaute só declara o tipo `TInutNFe`. A validação usa uma raiz montada em
memória que apenas declara o elemento `inutNFe` com esse tipo oficial
(`packages/xsd/src/schema-registry.ts`).

## O que está implementado

| Pacote | Conteúdo | Testes |
|---|---|---|
| `@nfe/core` | módulo 11 alfanumérico, CNPJ, CPF, GTIN, chave de acesso, decimal exato, máquina de estados, XML Builder, pedido de inutilização, regressões | 173 |
| `@nfe/xsd` | validação contra o XSD oficial da NF-e (PL_010f) e da inutilização (PL_010d) | 13 |
| `@nfe/signer` | assinatura XML-DSig de NF-e e de pedido de inutilização, verificação e pipeline contra verificador independente | 31 |
| `@nfe/sefaz` | contrato do provider, interpretação de `cStat` (autorização, consulta, inutilização), SEFAZ simulada com fila | 68 |
| `@nfe/emission` | serviço de emissão, política de reconciliação, inutilização, suíte de contrato sobre store em memória | 68 |
| `@nfe/persistence` | migrations, RLS, invariantes no banco, store Postgres, fluxo completo em Postgres real | 59 |

Total: **412 testes**. Lint, typecheck strict, build e smoke limpos.

### Fluxo de emissão

```
createDraft ──> issue ──────────────> transmit ─────────────> desfecho
 (idempotente)   trava documento        grava tentativa         AUTHORIZED / DENIED / REJECTED
                 trava sequência        chama a SEFAZ           QUEUED (não enviado, 108/109)
                 monta, assina, XSD     conclui tentativa       PROCESSING (103/105)
                 consome o número                               PENDING_RECONCILIATION
                 (tudo ou nada)                                         │
                                                                reconcile (consulta espaçada pela política)
                                                                        │
                                                    217 repetido ──> voidNumber (inutilização)
                                                                        │
                                                NUMBER_VOIDED (102 ou 563)  ou  241: consulta decide
```

Regras verificadas por teste, em memória e em Postgres real:

- **Número só é consumido com XML válido.** Montagem, assinatura e XSD
  acontecem com a sequência travada; qualquer falha desfaz a transação.
- **Sem `MAX + 1`.** `SELECT … FOR UPDATE` na sequência, com `UNIQUE` sobre
  `(emitente, ambiente, modelo, série, número)` como segunda defesa. Vinte
  emissões simultâneas recebem 1..20, com chaves distintas e XML válido.
- **Desfecho desconhecido nunca é retransmitido.** Timeout, duplicidade,
  código fora das tabelas e protocolo de outra chave levam a
  `PENDING_RECONCILIATION`, que só sai por consulta. A SEFAZ simulada confirma
  um único envio.
- **Tentativa é gravada antes da chamada.** Processo que cai com a requisição
  em voo deixa a tentativa aberta; a recuperação a trata como desfecho
  desconhecido. Resposta tardia e recuperação nunca aplicam os dois desfechos.
- **Duas transmissões simultâneas** do mesmo documento geram uma única chamada.
- **Mock não atende produção** — nem na fábrica, nem em cada chamada.
- **Pendente de retorno termina em consulta ou em inutilização.** A política
  espaça as consultas e só libera a inutilização depois de consultas repetidas
  com 217 e de um tempo mínimo desde o envio. O ciclo de reconciliação consulta
  e aponta, mas não inutiliza sozinho: inutilização é ato fiscal explícito.
- **A SEFAZ arbitra a inutilização.** A SEFAZ simulada retém notas na fila,
  como o Anexo III descreve. Se a nota for processada antes, a inutilização é
  recusada (241) e a consulta encontra a autorização; se a inutilização vier
  antes, a nota retida não é autorizada (206).
- **Repetir a inutilização sem resposta é seguro:** a SEFAZ devolve o protocolo
  do pedido idêntico já homologado (563).

### Invariantes garantidas pelo próprio Postgres

Exercitadas com SQL direto, sem passar pela aplicação:

| SQLSTATE | Garantia |
|---|---|
| `NFE01` | histórico de estados é somente inserção, inclusive para superusuário |
| `NFE02` | documento autorizado só passa para cancelado; denegado, cancelado e inutilizado não mudam; conteúdo congelado; nada é excluído |
| `NFE03` | reconciliação pendente só sai para os estados que `@nfe/core` permite — um teste compara os dois |
| `NFE04` | número consumido, série e ambiente não mudam |
| `NFE05` | XML de documento enfileirado ou transmitido não muda |
| `NFE06` | tentativa de comunicação concluída não é reescrita |
| `NFE07` | pedido de inutilização homologado, com seu protocolo, não é alterado nem excluído |

Isolamento entre tenants por **RLS com `FORCE`**: sem `app.tenant_id` na
transação nenhuma linha é visível, e gravar com tenant diferente é recusado. A
aplicação conecta com um papel sem superusuário e sem `BYPASSRLS`, sem `DELETE`
e sem `UPDATE` em histórico; `assertRestrictedRole` recusa subir com papel que
ignore RLS.

## Decisões

### Fatia do XML Builder

| # | Decisão | Motivo |
|---|---|---|
| Q1 | XML Builder + assinatura antes da persistência | domínio puro, testável sem infraestrutura |
| Q2 | Núcleo sem IBS/CBS/IS, com posição reservada | para CRT=1 a tributação começa em 2027 e a NT ainda não existe |
| Q5 | Contingência: normal e SVC-AN estruturalmente prontas; EPEC em fatia própria | SVC muda o endpoint, não o XML; EPEC é fluxo próprio |
| Q6 | `tpEmis` aceitos: 1, 4, 5, 6, 7 | 2 é legado, 3 tem divergência entre documentos oficiais, 9 é só NFC-e |

### Fatia de persistência e autorização

Registro completo, com fontes, em `docs/superpowers/specs/2026-09-10-nfe-design.md`, seção 9.

| # | Decisão | Motivo |
|---|---|---|
| Q3 | Numeração por `SELECT … FOR UPDATE`, consumida na assinatura | confirmada e testada com concorrência real |
| Q4 | Drizzle para consultas; migrations em SQL próprio com checksum | triggers e RLS revisáveis como SQL; teste compara mapeamento e banco |
| D5 | Nova aresta `SENDING → QUEUED` só para falha anterior ao envio ou 108/109 | nada foi processado |
| D6 | Consulta com 217 mantém a pendência | 217 não prova que a nota não esteja na fila |
| D7 | Rejeição mantém o número ao reemitir | a nota rejeitada não existe na SEFAZ |
| D11 | Postgres real nos testes via `embedded-postgres` | Docker indisponível nesta máquina; nenhum mock de banco |

### Fatia de inutilização e política de reconciliação

Registro completo, com fontes, no design doc, seção 10.

| # | Decisão | Motivo |
|---|---|---|
| D13 | Estado terminal `NUMBER_VOIDED` | fecha o ciclo das pendentes de retorno sem caminho de retransmissão |
| D14 | Inutilização de um único número por documento, com campos lidos da chave de acesso | recai exatamente sobre o número transmitido |
| D15 | Ano da inutilização = ano da chave de acesso | o MOC não define qual ano; a regra I08 não usa o ano |
| D16 | 241 mantém a pendência | a consulta decide o documento |
| D17 | 563 com `nProt` conta como inutilizado; sem `nProt`, não se presume | NT 2015.002 |
| D19 | Política: 1 min, intervalos de 2 a 60 min, 3 consultas com 217 e 60 min desde o envio | decisão arquitetural, parametrizável |
| D20 | O ciclo não inutiliza sozinho | ato fiscal exige decisão explícita |

### Decisões de implementação

- **Serializador XML próprio**, pequeno e testado: saída compacta, ordem de
  construção preservada e recusa de caractere inválido na montagem.
- **Texto fiscal não é "consertado" em silêncio.** Caractere fora de
  U+0020–U+00FF é recusado apontando o campo.
- **Serializar não arredonda.** O arredondamento pertence ao cálculo.
- **Assinatura com libxml2 + `node:crypto`**; `xml-crypto` só como verificador
  independente nos testes.
- **`cStat` fora das tabelas oficiais não vira rejeição por eliminação** — vira
  `UNRECOGNIZED`, e o fluxo não presume desfecho.
- **Uma suíte de contrato para todo `EmissionStore`.** O fake em memória roda
  exatamente os mesmos testes que o Postgres. Rodá-la contra o banco expôs uma
  divergência: o Postgres recusa chave de acesso repetida mesmo entre tenants
  (a chave é única no país), o fake não. O contrato passou a usar `cNF`
  aleatório, como o serviço; a unicidade da chave continua garantida só pelo
  banco.
- **Valores monetários do rascunho gravados como texto exato** no JSON, nunca
  como número em ponto flutuante.
- **Pacotes resolvem para o source em desenvolvimento e para `dist` em
  runtime**, pela condição de exportação `source`.

## O que NÃO está implementado

- provider SOAP da SEFAZ (envelope, mTLS com A1, parser de `retEnviNFe` e
  `retConsSitNFe`) — a interpretação de `cStat` já está pronta para ele;
- certificado A1: leitura de PFX, armazenamento cifrado, validação de cadeia
  ICP-Brasil (o signer recebe chave e certificado em PEM);
- agendamento: filas e workers que chamem `runReconciliationCycle` e
  `recoverAbandonedAttempts` periodicamente — hoje são chamados explicitamente;
- inutilização de faixas sem documento associado (o serviço inutiliza o número
  de um documento) e reemissão automática da operação com novo número depois
  da inutilização;
- arquivamento do `procInutNFe` (pedido + retorno) — hoje ficam gravados o
  pedido assinado e os campos do protocolo;
- consulta de recibo (`nfeRetAutorizacao`) para lote assíncrono;
- eventos (cancelamento, CC-e) e EPEC;
- RBAC, autenticação, trilha de auditoria de usuário;
- DANFE, API NestJS, frontend Next.js, Docker Compose;
- IBS, CBS e IS;
- grupos fora do escopo do builder: ICMS do regime normal (CST), substituição
  tributária, IPI, II, ISSQN, destinatário estrangeiro, item fora do total,
  unidade tributável diferente da comercial, grupo `card`, transportadora e
  volumes, cobrança.

## Revisão de código de 2026-09-10

Uma revisão em dois eixos encontrou seis defeitos reais na primeira versão da
fundação. Todos foram reproduzidos por teste antes de serem corrigidos; os
testes ficaram como regressão em `packages/core/tests/review-regressions.test.ts`.

| # | Defeito | Impacto |
|---|---|---|
| 1 | `allocate` estourava `RangeError` com pesos fracionários mínimos | falha crua no meio da emissão |
| 2 | resto do rateio ia para item de peso zero | item excluído recebia centavo de frete/desconto |
| 3 | AAMM da chave derivava de UTC | nota emitida após 21h no último dia do mês recebia competência errada |
| 4 | `PENDING_RECONCILIATION` alcançava `SENDING` via `CONTINGENCY` | caminho de retransmissão — NF-e duplicada |
| 5 | `times()` truncava em silêncio | perda de precisão e de sinal em produtos pequenos |
| 6 | `toScaledUnits` fixava `HalfUp` | rateio nunca conseguia usar half-even |

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
- valores da política de reconciliação (1 min até a primeira consulta,
  intervalos de 2 a 60 min, 3 consultas com 217, 60 min desde o envio antes de
  inutilizar): decisão arquitetural e parametrizável, não regra oficial;
- ano informado no pedido de inutilização: adotado o ano da chave de acesso,
  porque o MOC não especifica;
- reemissão com o mesmo número após rejeição em emissão normal: prática adotada
  pelos emissores de referência; o Anexo III só trata explicitamente do caso de
  contingência;
- regras de validação da SEFAZ que o XSD não expressa e que **não** foram
  implementadas por falta de confirmação em fonte oficial: razão social do
  destinatário em homologação, `indIntermed` conforme `indPres`, grupo `card`
  para pagamento com cartão, `cNF` diferente de `nNF`, obrigatoriedade de
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
npm test           # 412 testes nos seis pacotes
npm run build      # emite dist/ na ordem de dependência
npm run smoke      # exercita o dist compilado, não o source
```

Os testes de `@nfe/persistence` e o smoke sobem um **Postgres 18 real** com
`embedded-postgres`, num diretório temporário e numa porta livre, com senhas
geradas a cada execução e nunca gravadas. Não precisa de Docker nem de Postgres
instalado, e não toca em serviços Postgres já existentes na máquina.

`npm run smoke` importa `dist/` como um consumidor real importaria e percorre:
chave com CNPJ alfanumérico → XML → assinatura → XSD oficial → detecção de
adulteração → migrations → papel restrito → emissão com resposta perdida →
reconciliação → recusa do banco em reabrir NF-e autorizada → nota que nunca
chegou, consultada três vezes e com a numeração inutilizada, com o pedido
validado no XSD do PL_010d e a assinatura conferida.

Requisitos: Node >= 22. Sem toolchain nativo — validação XSD e canonicalização
usam `libxml2-wasm`.

### Aviso de dependência de desenvolvimento

`npm audit` aponta vulnerabilidades no Vitest 2.x e em suas dependências (Vite,
esbuild), com correção apenas no Vitest 5 (versão major). Afetam o servidor de
desenvolvimento e a interface web do Vitest, que este projeto não usa — os
testes rodam com `vitest run`. Não entram no runtime da aplicação. A
atualização fica registrada como pendência.

## Estrutura

```
docs/superpowers/specs/   design e decisões, com fontes
schemas/nfe/              XSDs oficiais versionados
packages/core/            domínio fiscal puro — sem IO, sem framework
packages/xsd/             validação contra o XSD oficial
packages/signer/          assinatura XML-DSig e verificação
packages/sefaz/           contrato com a SEFAZ, tabelas de cStat, SEFAZ simulada
packages/emission/        casos de uso de emissão e portas
packages/persistence/     Postgres: migrations, RLS, invariantes, store
  migrations/             SQL versionado — fonte da verdade do esquema
scripts/smoke.mjs         smoke test sobre os pacotes compilados
```

`packages/core` não importa framework, banco, HTTP nem filesystem.
`packages/emission` não conhece Postgres, SOAP nem biblioteca de assinatura:
recebe tudo por injeção.
