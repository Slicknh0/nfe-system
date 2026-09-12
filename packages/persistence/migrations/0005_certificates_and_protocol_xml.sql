-- XML devolvido pela SEFAZ e certificados A1 dos emitentes, cifrados.
--
-- protocol_xml guarda o protNFe como a SEFAZ devolveu, necessário para compor
-- o nfeProc entregue ao destinatário. response_xml guarda o retInutNFe.
--
-- issuer_certificates guarda PFX e senha SEMPRE cifrados (AES-256-GCM, chave
-- mestra fora do banco). O banco nunca vê o segredo em claro, e o cadastro é
-- imutável: trocar de certificado é cadastrar outro e desativar o anterior.
--
--   NFE08  certificado cadastrado

ALTER TABLE invoices ADD COLUMN protocol_xml text;
ALTER TABLE invoices ADD CONSTRAINT invoices_protocol_xml_requires_protocol
  CHECK (protocol_xml IS NULL OR protocol_number IS NOT NULL);

ALTER TABLE number_voids ADD COLUMN response_xml text;
ALTER TABLE number_voids ADD CONSTRAINT number_voids_response_xml_requires_protocol
  CHECK (response_xml IS NULL OR protocol_number IS NOT NULL);

-- Mesma função de 0004, com protocol_xml entre as colunas congeladas.
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
        NEW.protocol_status_reason, NEW.protocol_received_at, NEW.protocol_digest_value, NEW.protocol_xml)
       IS DISTINCT FROM
       (OLD.draft, OLD.access_key, OLD.signed_xml, OLD.protocol_number, OLD.protocol_status_code,
        OLD.protocol_status_reason, OLD.protocol_received_at, OLD.protocol_digest_value, OLD.protocol_xml)
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

CREATE TABLE issuer_certificates (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  issuer_id          uuid NOT NULL,
  fingerprint_sha256 char(95) NOT NULL CHECK (fingerprint_sha256 ~ '^([0-9A-F]{2}:){31}[0-9A-F]{2}$'),
  subject            text NOT NULL,
  holder_cnpj        char(14) NOT NULL CHECK (holder_cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$'),
  not_before         timestamptz NOT NULL,
  not_after          timestamptz NOT NULL,
  -- Formato do cofre: nfev1.<chave>.<iv>.<tag>.<texto cifrado>.
  sealed_pfx         text NOT NULL CHECK (sealed_pfx LIKE 'nfev1.%'),
  sealed_passphrase  text NOT NULL CHECK (sealed_passphrase LIKE 'nfev1.%'),
  active             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  deactivated_at     timestamptz,

  FOREIGN KEY (tenant_id, issuer_id) REFERENCES issuers (tenant_id, id),
  UNIQUE (issuer_id, fingerprint_sha256),
  CHECK (not_after > not_before),
  CHECK (active = (deactivated_at IS NULL))
);

-- No máximo um certificado ativo por emitente.
CREATE UNIQUE INDEX issuer_certificates_one_active_idx ON issuer_certificates (issuer_id) WHERE active;

CREATE FUNCTION nfe_guard_issuer_certificate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Certificado cadastrado não é excluído; desative-o.' USING ERRCODE = 'NFE08';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.issuer_id, NEW.fingerprint_sha256, NEW.subject, NEW.holder_cnpj,
      NEW.not_before, NEW.not_after, NEW.sealed_pfx, NEW.sealed_passphrase, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.issuer_id, OLD.fingerprint_sha256, OLD.subject, OLD.holder_cnpj,
      OLD.not_before, OLD.not_after, OLD.sealed_pfx, OLD.sealed_passphrase, OLD.created_at)
  THEN
    RAISE EXCEPTION 'O certificado cadastrado % é imutável.', OLD.id USING ERRCODE = 'NFE08';
  END IF;
  IF NOT OLD.active AND NEW.active THEN
    RAISE EXCEPTION 'Certificado desativado não volta a ser ativo; cadastre-o de novo.' USING ERRCODE = 'NFE08';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER issuer_certificates_guard
  BEFORE UPDATE OR DELETE ON issuer_certificates
  FOR EACH ROW EXECUTE FUNCTION nfe_guard_issuer_certificate();

ALTER TABLE issuer_certificates ENABLE ROW LEVEL SECURITY;
ALTER TABLE issuer_certificates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON issuer_certificates
  USING (tenant_id = nfe_current_tenant_id())
  WITH CHECK (tenant_id = nfe_current_tenant_id());
