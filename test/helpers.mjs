// Shared test fixture: an in-memory tenant with a chart of accounts.
import path from 'node:path';
import url from 'node:url';
import { openDatabase, migrate, Repo, transaction } from '../src/core/db.mjs';
import { provisionTenant, postingAccounts } from '../src/modules/setup.mjs';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

export function freshTenant({ name = 'Test Co', currency = 'USD' } = {}) {
  const db = openDatabase(':memory:');
  migrate(db, path.join(ROOT, 'migrations'));
  const t = transaction(db, () => provisionTenant(db, {
    name, ownerEmail: 'owner@test.local', ownerPassword: 'Correct-Horse-9',
    baseCurrency: currency, fiscalYear: 2026,
  }));
  const repo = new Repo(db, t.tenant.id, { user: { id: t.ownerId, name: 'Owner' } });
  return {
    db, repo, tenant: t.tenant, ownerId: t.ownerId, subsidiaryId: t.subsidiaryId,
    accounts: t.accounts, roleIds: t.roleIds,
    posting: postingAccounts(repo),
    location: repo.queryOne('SELECT * FROM location WHERE tenant_id = :t LIMIT 1'),
    tx: (fn) => transaction(db, fn),
  };
}

export const DATE = '2026-06-15';
