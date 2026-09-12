-- Isolamento entre tenants no próprio banco.
--
-- A aplicação abre cada transação com set_config('app.tenant_id', ..., true).
-- Sem essa configuração, nenhuma linha é visível. FORCE aplica a política
-- também ao dono das tabelas; apenas superusuário e papéis com BYPASSRLS ficam
-- de fora, e a aplicação não deve conectar com nenhum dos dois.

CREATE FUNCTION nfe_current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants
  USING (id = nfe_current_tenant_id())
  WITH CHECK (id = nfe_current_tenant_id());

ALTER TABLE issuers ENABLE ROW LEVEL SECURITY;
ALTER TABLE issuers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON issuers
  USING (tenant_id = nfe_current_tenant_id())
  WITH CHECK (tenant_id = nfe_current_tenant_id());

ALTER TABLE number_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE number_sequences FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON number_sequences
  USING (tenant_id = nfe_current_tenant_id())
  WITH CHECK (tenant_id = nfe_current_tenant_id());

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invoices
  USING (tenant_id = nfe_current_tenant_id())
  WITH CHECK (tenant_id = nfe_current_tenant_id());

ALTER TABLE invoice_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_status_history FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invoice_status_history
  USING (tenant_id = nfe_current_tenant_id())
  WITH CHECK (tenant_id = nfe_current_tenant_id());

ALTER TABLE sefaz_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sefaz_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sefaz_attempts
  USING (tenant_id = nfe_current_tenant_id())
  WITH CHECK (tenant_id = nfe_current_tenant_id());
