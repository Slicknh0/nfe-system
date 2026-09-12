/**
 * Papel de banco da aplicação.
 *
 * A aplicação conecta com um papel sem superusuário e sem BYPASSRLS, com
 * permissões mínimas: nada de DELETE, nada de UPDATE em histórico. As
 * migrations rodam com outro papel, dono das tabelas.
 */

import pg from 'pg';
import type { Pool } from 'pg';

export async function grantApplicationAccess(pool: Pool, role: string): Promise<void> {
  const grantee = pg.escapeIdentifier(role);
  await pool.query(`
    GRANT USAGE ON SCHEMA public TO ${grantee};
    GRANT SELECT, INSERT ON tenants, issuers, invoice_status_history TO ${grantee};
    GRANT SELECT, INSERT, UPDATE ON number_sequences, invoices, sefaz_attempts, number_voids, issuer_certificates TO ${grantee};
  `);
}

export class UnsafeDatabaseRoleError extends Error {
  constructor(role: string) {
    super(
      `O papel ${role} é superusuário ou ignora RLS. A aplicação precisa de um papel restrito para garantir o isolamento entre tenants.`,
    );
    this.name = 'UnsafeDatabaseRoleError';
  }
}

/** Para chamar na inicialização: recusa subir com um papel que ignora RLS. */
export async function assertRestrictedRole(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
    'SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
  );
  const role = rows[0];
  if (role === undefined || role.rolsuper || role.rolbypassrls) {
    throw new UnsafeDatabaseRoleError(role?.rolname ?? 'atual');
  }
}
