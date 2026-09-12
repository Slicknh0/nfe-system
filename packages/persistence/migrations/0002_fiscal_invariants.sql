-- Invariantes fiscais garantidas pelo banco, independentemente da aplicação.
--
-- A aplicação já valida tudo isto pela máquina de estados. Os triggers existem
-- para o caso em que a aplicação erra, é contornada ou alguém executa SQL à mão:
-- documento autorizado não muda, número consumido não muda e documento com
-- desfecho desconhecido não volta para a fila.
--
-- Códigos SQLSTATE próprios (classe NFE) permitem distinguir cada violação.
--   NFE01  tabela somente inserção
--   NFE02  documento autorizado, denegado ou cancelado
--   NFE03  reconciliação pendente só sai por desfecho descoberto
--   NFE04  identidade ou número do documento
--   NFE05  conteúdo de documento em transmissão
--   NFE06  tentativa de comunicação concluída

CREATE FUNCTION nfe_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A tabela % é somente inserção.', TG_TABLE_NAME USING ERRCODE = 'NFE01';
END;
$$;

CREATE TRIGGER invoice_status_history_append_only
  BEFORE UPDATE OR DELETE ON invoice_status_history
  FOR EACH ROW EXECUTE FUNCTION nfe_forbid_mutation();

CREATE FUNCTION nfe_guard_invoice() RETURNS trigger
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

  -- Número consumido pertence para sempre à mesma série e ao mesmo ambiente.
  IF OLD.number IS NOT NULL AND
     (NEW.number, NEW.series, NEW.environment) IS DISTINCT FROM (OLD.number, OLD.series, OLD.environment)
  THEN
    RAISE EXCEPTION 'O número % do documento % é imutável.', OLD.number, OLD.id USING ERRCODE = 'NFE04';
  END IF;

  IF OLD.status IN ('AUTHORIZED', 'DENIED', 'CANCELLED') THEN
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
     NEW.status NOT IN ('PENDING_RECONCILIATION', 'AUTHORIZED', 'REJECTED', 'DENIED')
  THEN
    RAISE EXCEPTION 'Documento com desfecho desconhecido não pode passar para %.', NEW.status
      USING ERRCODE = 'NFE03';
  END IF;

  -- Depois de enfileirado, o XML é o que foi (ou pode ter sido) transmitido.
  IF OLD.status IN ('QUEUED', 'SENDING', 'PROCESSING', 'COMMUNICATION_ERROR',
                    'PENDING_RECONCILIATION', 'CONTINGENCY') AND
     (NEW.draft, NEW.access_key, NEW.signed_xml) IS DISTINCT FROM (OLD.draft, OLD.access_key, OLD.signed_xml)
  THEN
    RAISE EXCEPTION 'O conteúdo de documento em % é imutável.', OLD.status USING ERRCODE = 'NFE05';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER invoices_guard
  BEFORE UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION nfe_guard_invoice();

CREATE FUNCTION nfe_guard_sefaz_attempt() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Tentativa de comunicação não é excluída.' USING ERRCODE = 'NFE06';
  END IF;
  IF OLD.finished_at IS NOT NULL THEN
    RAISE EXCEPTION 'A tentativa % já foi concluída.', OLD.id USING ERRCODE = 'NFE06';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.invoice_id, NEW.operation, NEW.started_at)
     IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.invoice_id, OLD.operation, OLD.started_at)
  THEN
    RAISE EXCEPTION 'A identidade da tentativa % é imutável.', OLD.id USING ERRCODE = 'NFE06';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sefaz_attempts_guard
  BEFORE UPDATE OR DELETE ON sefaz_attempts
  FOR EACH ROW EXECUTE FUNCTION nfe_guard_sefaz_attempt();
