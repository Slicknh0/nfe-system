# NF-e modelo 55 — sistema de emissão

Sistema de emissão e gestão de Nota Fiscal Eletrônica modelo 55.

**Estado atual:** o núcleo monta o XML da NF-e, assina com XML-DSig e valida
contra o XSD oficial. A camada de aplicação emite com numeração concorrente
sem repetição, grava tudo em Postgres com isolamento por tenant e conduz o
ciclo de autorização — incluindo timeout, reconciliação por consulta e
inutilização da numeração das notas pendentes de retorno — contra uma SEFAZ
simulada ou pelo **provider SOAP real**, com autenticação mútua e certificado A1
guardado cifrado. O provider real foi exercitado contra uma SEFAZ local com TLS
mútuo de verdade, mas **ainda não contra a SEFAZ-SP**: isso exige certificado A1
e credenciamento em homologação. Ainda não há API HTTP nem interface. O que
existe e o que não existe está descrito abaixo, sem arredondar para cima.

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
| Não há API REST oficial para NF-e 55: o canal é SOAP 1.2 sobre TLS 1.2+ com autenticação mútua, mensagem em `nfeDadosMsg`, sem SOAP Header na 4.00 | MOC 7.0, Visão Geral, 4.2.2 e 4.4.1 |
| Certificado ICP-Brasil com CNPJ no otherName 2.16.76.1.3.3; assinatura exige CNPJ de estabelecimento do emitente, transmissão exige "Autenticação Cliente" | MOC 7.0, Visão Geral, 4.2.3; DOC-ICP-04 |
| O WSDL dos serviços só é entregue com certificado (HTTP 403 sem ele) | verificado em SP, SVRS e AN |
| O TLS da SEFAZ-SP termina na AC Raiz Brasileira v10 da ICP-Brasil, ausente do repositório padrão do Node | handshake com a homologação de SP; repositório do ITI |

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
| `@nfe/certificates` | certificado A1 (PKCS#12), CNPJ do otherName ICP-Brasil, regras de uso, cofre AES-256-GCM | 21 |
| `@nfe/sefaz` | contrato do provider, interpretação de `cStat` (autorização, consulta, inutilização), SEFAZ simulada com fila, provider SOAP com TLS mútuo | 87 |
| `@nfe/emission` | serviço de emissão, política de reconciliação, inutilização, suíte de contrato sobre store em memória, fluxo com o provider SOAP | 70 |
| `@nfe/persistence` | migrations, RLS, invariantes no banco, store Postgres, certificados cifrados, fluxo completo em Postgres real | 67 |

Total: **462 testes**. Lint, typecheck strict, build e smoke limpos.

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

### Comunicação com a SEFAZ real

`SoapSefazProvider` implementa o mesmo contrato do mock: autorização (`enviNFe`
síncrono com uma NF-e), consulta de protocolo (`consSitNFe`) e inutilização
(`inutNFe` assinado). `HttpsSoapTransport` faz o TLS mútuo.

- **Verificação do servidor sempre ligada.** A raiz ICP-Brasil v10 está fixada
  com o fingerprint; foi conferida pelo repositório de raízes do Windows, pela
  assinatura da AC intermediária que a SEFAZ-SP apresenta e por um handshake
  real com a homologação de SP. Não existe opção para desligar a verificação.
- **Classificação de falha sem otimismo.** Falha antes do handshake e do corpo
  completos é "não enviado"; depois disso, sem resposta completa, é desfecho
  desconhecido. HTTP 4xx é erro de configuração. SOAP Fault, HTTP 5xx, resposta
  ininteligível ou de outro ambiente são desfecho desconhecido, e o documento
  vai para reconciliação.
- **Produção só com `productionEnabled: true`.**
- **Mensagens conferidas contra o XSD oficial nos testes:** `enviNFe`,
  `consSitNFe` e `inutNFe` enviados, e os retornos usados pelos testes.
- **XML devolvido pela SEFAZ é guardado** (`protNFe` e `retInutNFe`), para
  compor `nfeProc` e `procInutNFe`.

Certificado A1 (`@nfe/certificates` e `IssuerCertificateRegistry`):

- PFX lido e conferido no cadastro: senha, validade, CNPJ da mesma empresa do
  emitente, uso para assinatura digital e "Autenticação Cliente";
- PFX e senha guardados só cifrados (AES-256-GCM), com contexto que amarra o
  segredo a tenant, emitente e finalidade; chave mestra fora do banco, com
  rotação por identificador;
- um certificado ativo por emitente; o cadastro é imutável e não é excluído;
- `registry.signer()` assina NF-e e inutilização com o certificado ativo;
  emitente sem certificado para em validação local, sem consumir número.

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
| `NFE08` | certificado cadastrado não é alterado, excluído nem reativado |

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

### Fatia de comunicação SOAP e certificado A1

Registro completo, com fontes, no design doc, seção 11.

| # | Decisão | Motivo |
|---|---|---|
| D22 | Sem API comercial, sem NFeWizard (GPL-3.0), transporte próprio | terceirizar ou duplicar o núcleo fiscal já validado não compensa |
| D23 | Raiz ICP-Brasil fixada; verificação do servidor não configurável | segurança não vira opção |
| D24 | Na dúvida sobre o envio, desfecho desconhecido | um erro nessa direção cai em duplicidade e reconciliação |
| D26 | Operação e método SOAP da referência sped-nfe | o WSDL não é público; conferir com o A1 |
| D28 | Cofre AES-256-GCM com contexto por tenant e emitente | senha e PFX nunca em claro |
| D31 | Um transporte por instância do provider | certificado de transmissão por emitente fica para a API |

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

- transmissão real para a SEFAZ-SP — exige certificado A1 e credenciamento em
  homologação; nenhum teste fala com a SEFAZ de verdade;
- conferência dos nomes de operação e método SOAP contra o `?wsdl` real;
- escolha do certificado de transmissão por emitente (o provider recebe um
  transporte por instância);
- validação da cadeia ICP-Brasil e da LCR do certificado do emitente (a SEFAZ
  valida; aqui são conferidos validade, CNPJ e finalidades);
- endereços de contingência SVC-AN e consulta de recibo (`nfeRetAutorizacao`);
- certificado A3 (token/cartão);
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
- nomes de operação e método SOAP (`NFeAutorizacao4/nfeAutorizacaoLote`,
  `NFeConsultaProtocolo4/nfeConsultaNF`, `NFeInutilizacao4/nfeInutilizacaoNF`):
  vêm da implementação de referência e precisam ser conferidos no WSDL;
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
npm test           # 462 testes nos sete pacotes
npm run build      # emite dist/ na ordem de dependência
npm run smoke      # exercita o dist compilado, não o source
```

Os testes de `@nfe/persistence` e o smoke sobem um **Postgres 18 real** com
`embedded-postgres`, num diretório temporário e numa porta livre, com senhas
geradas a cada execução e nunca gravadas. Não precisa de Docker nem de Postgres
instalado, e não toca em serviços Postgres já existentes na máquina.

Os testes do provider SOAP sobem uma SEFAZ local com HTTPS e autenticação mútua,
com uma PKI de teste gerada em memória (AC, certificado de servidor e
certificados com CNPJ no otherName). Nenhum certificado real é usado ou gravado.

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
packages/certificates/    certificado A1, regras ICP-Brasil, cofre de segredos
packages/sefaz/           contrato com a SEFAZ, cStat, SEFAZ simulada, provider SOAP
packages/emission/        casos de uso de emissão e portas
packages/persistence/     Postgres: migrations, RLS, invariantes, store
  migrations/             SQL versionado — fonte da verdade do esquema
scripts/smoke.mjs         smoke test sobre os pacotes compilados
```

`packages/core` não importa framework, banco, HTTP nem filesystem.
`packages/emission` não conhece Postgres, SOAP nem biblioteca de assinatura:
recebe tudo por injeção.
