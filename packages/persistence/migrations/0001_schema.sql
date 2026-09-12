-- Esquema inicial: tenants, emitentes, numeração, documentos, histórico e
-- tentativas de comunicação com a SEFAZ.
--
-- Toda tabela de negócio carrega tenant_id, e toda referência entre tabelas
-- inclui tenant_id na chave estrangeira: um documento não consegue apontar para
-- o emitente de outro tenant nem por erro de aplicação.

CREATE TABLE tenants (
  id         uuid PRIMARY KEY,
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE issuers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  -- TCnpj do schema oficial: 12 posições alfanuméricas e 2 dígitos verificadores.
  cnpj       char(14) NOT NULL CHECK (cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$'),
  legal_name text NOT NULL CHECK (length(legal_name) BETWEEN 1 AND 60),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, cnpj),
  UNIQUE (tenant_id, id)
);

-- Numeração por emitente, ambiente, modelo e série.
--
-- O próximo número é lido com SELECT ... FOR UPDATE e incrementado na mesma
-- transação que grava o XML assinado. Nunca MAX(number) + 1: duas transações
-- concorrentes leriam o mesmo máximo.
CREATE TABLE number_sequences (
  tenant_id   uuid NOT NULL,
  issuer_id   uuid NOT NULL,
  environment smallint NOT NULL CHECK (environment IN (1, 2)),
  model       smallint NOT NULL CHECK (model = 55),
  series      integer NOT NULL CHECK (series BETWEEN 0 AND 999),
  -- nNF vai de 1 a 999999999 (TNF). 1000000000 significa série esgotada.
  next_number integer NOT NULL DEFAULT 1 CHECK (next_number BETWEEN 1 AND 1000000000),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer_id, environment, model, series),
  FOREIGN KEY (tenant_id, issuer_id) REFERENCES issuers (tenant_id, id)
);

CREATE TABLE invoices (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL,
  issuer_id              uuid NOT NULL,
  idempotency_key        text NOT NULL CHECK (idempotency_key ~ '^[!-~]{1,255}$'),
  request_hash           char(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  environment            smallint NOT NULL CHECK (environment IN (1, 2)),
  model                  smallint NOT NULL DEFAULT 55 CHECK (model = 55),
  series                 integer NOT NULL CHECK (series BETWEEN 0 AND 999),
  status                 text NOT NULL CHECK (status IN (
                           'DRAFT', 'VALIDATING', 'VALIDATED', 'SIGNED', 'QUEUED', 'SENDING',
                           'PROCESSING', 'AUTHORIZED', 'LOCAL_VALIDATION_ERROR', 'REJECTED',
                           'COMMUNICATION_ERROR', 'PENDING_RECONCILIATION', 'CONTINGENCY',
                           'DENIED', 'CANCELLED')),
  version                integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  -- Rascunho com valores monetários como texto exato ({"$decimal": "49.9"}).
  draft                  jsonb NOT NULL,
  number                 integer CHECK (number BETWEEN 1 AND 999999999),
  -- TChNFe do schema oficial.
  access_key             char(44) CHECK (access_key ~ '^[0-9]{6}[0-9A-Z]{12}[0-9]{26}$'),
  signed_xml             text,
  -- protNFe/infProt. TProt: 15 ou 17 dígitos.
  protocol_number        varchar(17) CHECK (protocol_number ~ '^([0-9]{15}|[0-9]{17})$'),
  protocol_status_code   integer,
  protocol_status_reason text,
  protocol_received_at   timestamptz,
  protocol_digest_value  text,
  last_status_code       integer,
  last_status_reason     text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY (tenant_id, issuer_id) REFERENCES issuers (tenant_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key),
  -- Segunda linha de defesa contra número repetido, além do FOR UPDATE.
  UNIQUE (issuer_id, environment, model, series, number),
  UNIQUE (access_key),

  CHECK ((access_key IS NULL) = (signed_xml IS NULL)),
  CHECK (access_key IS NULL OR number IS NOT NULL),
  CHECK ((last_status_code IS NULL) = (last_status_reason IS NULL)),
  CHECK (
    (protocol_number IS NULL) = (protocol_received_at IS NULL) AND
    (protocol_number IS NULL) = (protocol_status_code IS NULL) AND
    (protocol_number IS NULL) = (protocol_status_reason IS NULL)
  ),
  -- A partir da assinatura, o documento sempre tem XML.
  CHECK (
    status IN ('DRAFT', 'VALIDATING', 'VALIDATED', 'LOCAL_VALIDATION_ERROR') OR signed_xml IS NOT NULL
  ),
  -- Autorização e denegação só existem com protocolo.
  CHECK (status NOT IN ('AUTHORIZED', 'DENIED', 'CANCELLED') OR protocol_number IS NOT NULL)
);

CREATE INDEX invoices_tenant_status_idx ON invoices (tenant_id, status, updated_at);

-- Trilha de estados, somente inserção (ver 0002).
CREATE TABLE invoice_status_history (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  invoice_id  uuid NOT NULL,
  from_status text,
  to_status   text NOT NULL,
  reason      text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id)
);

CREATE INDEX invoice_status_history_invoice_idx ON invoice_status_history (invoice_id, id);

-- Cada chamada à SEFAZ é registrada ANTES de acontecer. Tentativa sem
-- finished_at é uma chamada cujo desfecho o sistema não conhece.
CREATE TABLE sefaz_attempts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  invoice_id    uuid NOT NULL,
  operation     text NOT NULL CHECK (operation IN ('AUTHORIZATION', 'PROTOCOL_QUERY')),
  started_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at   timestamptz,
  outcome       text CHECK (outcome IN (
                  'AUTHORIZED', 'DENIED', 'REJECTED', 'DUPLICATE', 'IN_PROCESSING',
                  'SERVICE_UNAVAILABLE', 'UNRECOGNIZED', 'CANCELLED', 'NOT_FOUND',
                  'QUERY_REJECTED', 'PROTOCOL_MISMATCH', 'NOT_SENT', 'NO_RESPONSE', 'ABANDONED')),
  status_code   integer,
  status_reason text,
  detail        text,
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id),
  CHECK ((finished_at IS NULL) = (outcome IS NULL))
);

CREATE INDEX sefaz_attempts_unfinished_idx ON sefaz_attempts (tenant_id, started_at)
  WHERE finished_at IS NULL;
CREATE INDEX sefaz_attempts_invoice_idx ON sefaz_attempts (invoice_id, started_at);
