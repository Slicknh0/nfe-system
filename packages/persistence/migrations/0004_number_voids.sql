-- Inutilização de numeração (MOC 7.0, Visão Geral, 5.3; Anexo III, 2.3.3).
--
-- NUMBER_VOIDED é o desfecho do documento cujo número foi inutilizado na SEFAZ:
-- terminal, imutável e sempre com número. O pedido assinado e o protocolo de
-- homologação ficam em number_voids — são a prova da inutilização.
--
--   NFE07  pedido de inutilização homologado ou faixa de pedido

ALTER TABLE invoices DROP CONSTRAINT invoices_status_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_status_check CHECK (status IN (
  'DRAFT', 'VALIDATING', 'VALIDATED', 'SIGNED', 'QUEUED', 'SENDING',
  'PROCESSING', 'AUTHORIZED', 'LOCAL_VALIDATION_ERROR', 'REJECTED',
  'COMMUNICATION_ERROR', 'PENDING_RECONCILIATION', 'CONTINGENCY',
  'DENIED', 'CANCELLED', 'NUMBER_VOIDED'));
ALTER TABLE invoices ADD CONSTRAINT invoices_voided_has_number
  CHECK (status <> 'NUMBER_VOIDED' OR number IS NOT NULL);

ALTER TABLE sefaz_attempts DROP CONSTRAINT sefaz_attempts_operation_check;
ALTER TABLE sefaz_attempts ADD CONSTRAINT sefaz_attempts_operation_check
  CHECK (operation IN ('AUTHORIZATION', 'PROTOCOL_QUERY', 'NUMBER_VOID'));

ALTER TABLE sefaz_attempts DROP CONSTRAINT sefaz_attempts_outcome_check;
ALTER TABLE sefaz_attempts ADD CONSTRAINT sefaz_attempts_outcome_check CHECK (outcome IN (
  'AUTHORIZED', 'DENIED', 'REJECTED', 'DUPLICATE', 'IN_PROCESSING',
  'SERVICE_UNAVAILABLE', 'UNRECOGNIZED', 'CANCELLED', 'NOT_FOUND',
  'QUERY_REJECTED', 'PROTOCOL_MISMATCH', 'VOIDED', 'RANGE_ALREADY_VOIDED',
  'NUMBER_ALREADY_USED', 'NOT_SENT', 'NO_RESPONSE', 'ABANDONED'));

CREATE TABLE number_voids (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL,
  invoice_id             uuid NOT NULL,
  environment            smallint NOT NULL CHECK (environment IN (1, 2)),
  model                  smallint NOT NULL DEFAULT 55 CHECK (model = 55),
  series                 integer NOT NULL CHECK (series BETWEEN 0 AND 999),
  first_number           integer NOT NULL CHECK (first_number BETWEEN 1 AND 999999999),
  last_number            integer NOT NULL CHECK (last_number BETWEEN 1 AND 999999999),
  -- Regras I02b/I02c: não anterior a 2006.
  year                   smallint NOT NULL CHECK (year BETWEEN 2006 AND 2099),
  -- TJust: 15 a 255 caracteres.
  justification          text NOT NULL CHECK (length(justification) BETWEEN 15 AND 255),
  -- Pattern do atributo Id de TInutNFe (PL_010d_v1.03).
  request_id             char(43) NOT NULL CHECK (request_id ~ '^ID[0-9]{4}[0-9A-Z]{12}[0-9]{25}$'),
  signed_xml             text NOT NULL,
  status                 text NOT NULL CHECK (status IN ('REQUESTED', 'VOIDED', 'REJECTED')),
  protocol_number        varchar(17) CHECK (protocol_number ~ '^([0-9]{15}|[0-9]{17})$'),
  protocol_status_code   integer,
  protocol_status_reason text,
  protocol_received_at   timestamptz,
  last_status_code       integer,
  last_status_reason     text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices (tenant_id, id),
  UNIQUE (invoice_id),
  -- Regras I03 e I04: faixa ordenada, no máximo 10.000 números.
  CHECK (first_number <= last_number AND last_number - first_number < 10000),
  CHECK (
    (protocol_number IS NULL) = (protocol_received_at IS NULL) AND
    (protocol_number IS NULL) = (protocol_status_code IS NULL) AND
    (protocol_number IS NULL) = (protocol_status_reason IS NULL)
  ),
  CHECK (protocol_number IS NULL OR status = 'VOIDED'),
  CHECK ((last_status_code IS NULL) = (last_status_reason IS NULL))
);

CREATE FUNCTION nfe_guard_number_void() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Pedido de inutilização não é excluído.' USING ERRCODE = 'NFE07';
  END IF;
  IF OLD.status = 'VOIDED' THEN
    RAISE EXCEPTION 'A inutilização homologada % é imutável.', OLD.id USING ERRCODE = 'NFE07';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.invoice_id, NEW.environment, NEW.model, NEW.series,
      NEW.first_number, NEW.last_number, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.invoice_id, OLD.environment, OLD.model, OLD.series,
      OLD.first_number, OLD.last_number, OLD.created_at)
  THEN
    RAISE EXCEPTION 'A faixa do pedido de inutilização % é imutável.', OLD.id USING ERRCODE = 'NFE07';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER number_voids_guard
  BEFORE UPDATE OR DELETE ON number_voids
  FOR EACH ROW EXECUTE FUNCTION nfe_guard_number_void();

-- Mesma função de 0002, com NUMBER_VOIDED entre os estados congelados e entre
-- as saídas permitidas da reconciliação pendente.
CREATE OR REPLACE FUNCTION nfe_guard_invoice() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Documento fiscal não é excluído.' USING ERRCODE = 'NFE02';
  END IF;

  IF (NEW.id, NEW.tenant_id, NEW.issuer_id, NEW.idempotency_key, NEW.request_hash, NEW.model, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.issuer_id, OLD.idempotency_key, OLD.request_hash, OLD.model, OLD.created_at)
  THEN
    RAISE EXCEPTION 'A identidade do documento % é imutável.', OLD.id USING ERRCODE = 'NFE04';
  END IF;

  IF OLD.number IS NOT NULL AND
     (NEW.number, NEW.series, NEW.environment) IS DISTINCT FROM (OLD.number, OLD.series, OLD.environment)
  THEN
    RAISE EXCEPTION 'O número % do documento % é imutável.', OLD.number, OLD.id USING ERRCODE = 'NFE04';
  END IF;

  IF OLD.status IN ('AUTHORIZED', 'DENIED', 'CANCELLED', 'NUMBER_VOIDED') THEN
    IF NEW.status <> OLD.status AND NOT (OLD.status = 'AUTHORIZED' AND NEW.status = 'CANCELLED') THEN
      RAISE EXCEPTION 'Documento em % não pode passar para %.', OLD.status, NEW.status
        USING ERRCODE = 'NFE02';
    END IF;
    IF (NEW.draft, NEW.access_key, NEW.signed_xml, NEW.protocol_number, NEW.protocol_status_code,
        NEW.protocol_status_reason, NEW.protocol_received_at, NEW.protocol_digest_value)
       IS DISTINCT FROM
       (OLD.draft, OLD.access_key, OLD.signed_xml, OLD.protocol_number, OLD.protocol_status_code,
        OLD.protocol_status_reason, OLD.protocol_received_at, OLD.protocol_digest_value)
    THEN
      RAISE EXCEPTION 'O conteúdo de documento em % é imutável.', OLD.status USING ERRCODE = 'NFE02';
    END IF;
  END IF;

  -- Espelha a máquina de estados de @nfe/core. Um teste compara as duas.
  IF OLD.status = 'PENDING_RECONCILIATION' AND
     NEW.status NOT IN ('PENDING_RECONCILIATION', 'AUTHORIZED', 'REJECTED', 'DENIED', 'NUMBER_VOIDED')
  THEN
    RAISE EXCEPTION 'Documento com desfecho desconhecido não pode passar para %.', NEW.status
      USING ERRCODE = 'NFE03';
  END IF;

  IF OLD.status IN ('QUEUED', 'SENDING', 'PROCESSING', 'COMMUNICATION_ERROR',
                    'PENDING_RECONCILIATION', 'CONTINGENCY') AND
     (NEW.draft, NEW.access_key, NEW.signed_xml) IS DISTINCT FROM (OLD.draft, OLD.access_key, OLD.signed_xml)
  THEN
    RAISE EXCEPTION 'O conteúdo de documento em % é imutável.', OLD.status USING ERRCODE = 'NFE05';
  END IF;

  RETURN NEW;
END;
$$;

ALTER TABLE number_voids ENABLE ROW LEVEL SECURITY;
ALTER TABLE number_voids FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON number_voids
  USING (tenant_id = nfe_current_tenant_id())
  WITH CHECK (tenant_id = nfe_current_tenant_id());
