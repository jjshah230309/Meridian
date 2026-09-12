// Trading in a currency that is not your own. The hard part is not the
// invoice, it is the settlement: the cash arrives at today's rate while the
// receivable is sitting in the ledger at the rate it went in at, and if the
// difference is not recognised the control account keeps a balance for an
// invoice that is fully paid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshTenant, DATE } from './helpers.mjs';
import * as gl from '../src/modules/gl.mjs';
import * as inv from '../src/modules/inventory.mjs';
import * as entities from '../src/modules/entities.mjs';
import * as T from '../src/modules/txn.mjs';
import { Money, Qty } from '../src/core/util.mjs';

const LATER = '2026-07-15';

/** A USD company with a euro customer, stock on the shelf, and two rates. */
function exporter({ payRate = 1.35 } = {}) {
  const f = freshTenant({ currency: 'USD' });
  f.tx(() => {
    f.repo.exec(`INSERT OR REPLACE INTO exchange_rate (tenant_id, from_currency, to_currency, rate_date, rate)
                 VALUES (:t,'EUR','USD',?,?)`, [DATE, 1.2]);
    f.repo.exec(`INSERT OR REPLACE INTO exchange_rate (tenant_id, from_currency, to_currency, rate_date, rate)
                 VALUES (:t,'EUR','USD',?,?)`, [LATER, payRate]);
  });
  f.customer = f.tx(() => entities.createCustomer(f.repo, { name: 'Europa GmbH', currency: 'EUR' }));
  f.vendor = f.tx(() => entities.createVendor(f.repo, { name: 'Rheinwerk AG', currency: 'EUR' }));
  f.widget = f.tx(() => inv.createItem(f.repo, { sku: 'FX-1', name: 'Widget', type: 'inventory', base_price: 100 }));
  f.tx(() => {
    const r = inv.moveStock(f.repo, {
      item_id: f.widget.id, location_id: f.location.id, qty_delta: Qty.parse(50),
      unit_cost: Money.parse(20), type: 'receipt', txn_date: DATE,
    });
    gl.postJournal(f.repo, {
      subsidiary_id: f.subsidiaryId, txn_date: DATE, memo: 'Opening stock',
      lines: [
        { account_id: f.posting.inventory, debit: r.value_delta },
        { account_id: f.accounts['3010'], credit: r.value_delta },
      ],
    });
  });
  return f;
}

const balance = (f, accountId) => f.repo.scalar(
  `SELECT COALESCE(SUM(jl.base_debit - jl.base_credit), 0) v
   FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id
   WHERE jl.tenant_id = :t AND je.status = 'posted' AND jl.account_id = ?`, [accountId], 0);

test('a foreign-currency invoice records both currencies', () => {
  const f = exporter();
  const invoice = f.tx(() => T.createTxn(f.repo, 'INVOICE', {
    entity_id: f.customer.id, txn_date: DATE, location_id: f.location.id,
    lines: [{ item_id: f.widget.id, quantity: 10, unit_price: 100 }],
  }));
  assert.equal(invoice.currency, 'EUR');
  assert.equal(invoice.fx_rate, 1.2);
  assert.equal(invoice.total, Money.parse(1000), 'the customer owes €1,000');
  assert.equal(invoice.base_total, Money.parse(1200), 'the books carry $1,200');
  assert.equal(balance(f, f.posting.ar), Money.parse(1200));
  assert.ok(gl.integrityCheck(f.repo).ok);
});

test('settling at a stronger rate books an exchange gain and clears the receivable', () => {
  const f = exporter({ payRate: 1.35 });
  const invoice = f.tx(() => T.createTxn(f.repo, 'INVOICE', {
    entity_id: f.customer.id, txn_date: DATE, location_id: f.location.id,
    lines: [{ item_id: f.widget.id, quantity: 10, unit_price: 100 }],
  }));
  f.tx(() => T.createPayment(f.repo, 'CUSTOMER_PAYMENT', {
    entity_id: f.customer.id, entity_type: 'customer', subsidiary_id: f.subsidiaryId,
    txn_date: LATER, currency: 'EUR', amount: 1000, account_id: f.posting.bank,
    applications: [{ txn_id: invoice.id, amount: 1000 }],
  }));

  assert.equal(balance(f, f.posting.ar), 0, 'a fully paid invoice leaves nothing in receivables');
  assert.equal(balance(f, f.posting.bank), Money.parse(1350), 'the bank got what the cash was worth');
  assert.equal(balance(f, f.posting.fx), -Money.parse(150), 'and the $150 gain is named');
  assert.ok(gl.integrityCheck(f.repo).ok);
});

test('settling at a weaker rate books an exchange loss', () => {
  const f = exporter({ payRate: 1.05 });
  const invoice = f.tx(() => T.createTxn(f.repo, 'INVOICE', {
    entity_id: f.customer.id, txn_date: DATE, location_id: f.location.id,
    lines: [{ item_id: f.widget.id, quantity: 10, unit_price: 100 }],
  }));
  f.tx(() => T.createPayment(f.repo, 'CUSTOMER_PAYMENT', {
    entity_id: f.customer.id, entity_type: 'customer', subsidiary_id: f.subsidiaryId,
    txn_date: LATER, currency: 'EUR', amount: 1000, account_id: f.posting.bank,
    applications: [{ txn_id: invoice.id, amount: 1000 }],
  }));
  assert.equal(balance(f, f.posting.ar), 0);
  assert.equal(balance(f, f.posting.fx), Money.parse(150), 'a loss is a debit');
  assert.ok(gl.integrityCheck(f.repo).ok);
});

test('a partial settlement leaves the unpaid remainder at its original rate', () => {
  const f = exporter({ payRate: 1.35 });
  const invoice = f.tx(() => T.createTxn(f.repo, 'INVOICE', {
    entity_id: f.customer.id, txn_date: DATE, location_id: f.location.id,
    lines: [{ item_id: f.widget.id, quantity: 10, unit_price: 100 }],
  }));
  f.tx(() => T.createPayment(f.repo, 'CUSTOMER_PAYMENT', {
    entity_id: f.customer.id, entity_type: 'customer', subsidiary_id: f.subsidiaryId,
    txn_date: LATER, currency: 'EUR', amount: 400, account_id: f.posting.bank,
    applications: [{ txn_id: invoice.id, amount: 400 }],
  }));
  // €600 still owed, still carried at 1.20 = $720.
  assert.equal(balance(f, f.posting.ar), Money.parse(720));
  assert.equal(balance(f, f.posting.fx), -Money.parse(60), 'gain on the €400 that settled');

  const check = gl.integrityCheck(f.repo);
  const ar = check.subledgers.find((s) => s.name === 'Receivables');
  assert.equal(ar.difference, 0, 'the tie-out values the open balance in base currency');
  assert.ok(check.ok);
});

test('voiding a settlement reverses the exchange difference with it', () => {
  const f = exporter({ payRate: 1.35 });
  const invoice = f.tx(() => T.createTxn(f.repo, 'INVOICE', {
    entity_id: f.customer.id, txn_date: DATE, location_id: f.location.id,
    lines: [{ item_id: f.widget.id, quantity: 10, unit_price: 100 }],
  }));
  const payment = f.tx(() => T.createPayment(f.repo, 'CUSTOMER_PAYMENT', {
    entity_id: f.customer.id, entity_type: 'customer', subsidiary_id: f.subsidiaryId,
    txn_date: LATER, currency: 'EUR', amount: 1000, account_id: f.posting.bank,
    applications: [{ txn_id: invoice.id, amount: 1000 }],
  }));
  f.tx(() => T.unapplyPayment(f.repo, payment.id, invoice.id));
  f.tx(() => T.voidTxn(f.repo, payment.id, { reason: 'entered twice' }));

  assert.equal(balance(f, f.posting.bank), 0, 'the cash is back out');
  assert.equal(balance(f, f.posting.fx), 0, 'and so is the gain');
  assert.equal(balance(f, f.posting.ar), Money.parse(1200), 'the invoice is outstanding again');
  assert.ok(gl.integrityCheck(f.repo).ok);
});

test('a part-paid foreign invoice leaves the control account exactly on the subledger', () => {
  const f = freshTenant();
  const rate = (d, r) => f.tx(() => f.repo.exec(
    `INSERT INTO exchange_rate (tenant_id, from_currency, to_currency, rate_date, rate) VALUES (:t,?,?,?,?)
     ON CONFLICT (tenant_id, from_currency, to_currency, rate_date) DO UPDATE SET rate = excluded.rate`,
    ['EUR', 'USD', d, r]));
  rate('2026-01-01', 1.0733);
  rate('2026-02-01', 1.1417);

  const acct = (n) => f.repo.queryOne('SELECT * FROM account WHERE tenant_id = :t AND number = ?', [n]);
  const customer = f.tx(() => entities.createCustomer(f.repo, {
    name: 'Continental SA', subsidiary_id: f.subsidiaryId, currency: 'EUR',
  }));
  const invoice = f.tx(() => T.createTxn(f.repo, 'INVOICE', {
    entity_id: customer.id, subsidiary_id: f.subsidiaryId, txn_date: '2026-01-01', currency: 'EUR',
    lines: [{ account_id: acct('4020').id, quantity: 1, unit_price: 333.33 }],
  }));

  // Three awkward part-payments, each landing mid-rounding.
  for (const amount of [111.11, 77.77, 44.44]) {
    f.tx(() => T.createPayment(f.repo, 'CUSTOMER_PAYMENT', {
      entity_id: customer.id, subsidiary_id: f.subsidiaryId, txn_date: '2026-02-01', currency: 'EUR',
      amount, account_id: acct('1010').id,
      applications: [{ txn_id: invoice.id, amount }],
    }));
    const tie = gl.tieOuts(f.repo).find((x) => x.name === 'Receivables');
    assert.equal(tie.difference, 0, `receivables adrift after paying ${amount}`);
  }
  assert.equal(gl.integrityCheck(f.repo).ok, true);
});

test('stock bought in another currency is carried at what it cost us', () => {
  const f = freshTenant();
  f.tx(() => f.repo.exec(
    `INSERT INTO exchange_rate (tenant_id, from_currency, to_currency, rate_date, rate) VALUES (:t,?,?,?,?)`,
    ['EUR', 'USD', '2026-01-01', 1.25]));
  const acct = (n) => f.repo.queryOne('SELECT * FROM account WHERE tenant_id = :t AND number = ?', [n]);
  const vendor = f.tx(() => entities.createVendor(f.repo, {
    name: 'Continental Parts GmbH', subsidiary_id: f.subsidiaryId, currency: 'EUR',
  }));
  const item = f.tx(() => inv.createItem(f.repo, {
    sku: 'EU-WIDGET', name: 'Imported widget', type: 'inventory', base_price: 200, standard_cost: 100,
  }));
  f.tx(() => T.createTxn(f.repo, 'VENDOR_BILL', {
    entity_id: vendor.id, subsidiary_id: f.subsidiaryId, txn_date: '2026-01-01', currency: 'EUR',
    location_id: f.location.id,
    lines: [{ item_id: item.id, quantity: 10, unit_price: 100 }],
  }));

  const pos = f.repo.queryOne(
    'SELECT * FROM item_location WHERE tenant_id = :t AND item_id = ?', [item.id]);
  assert.equal(pos.qty_on_hand, Qty.parse(10));
  assert.equal(pos.total_value, Money.parse(1250), '€1,000 at 1.25 is $1,250 of stock');

  const inventoryGl = f.repo.scalar(
    `SELECT COALESCE(SUM(jl.base_debit - jl.base_credit), 0) v FROM journal_line jl
     JOIN journal_entry je ON je.tenant_id = jl.tenant_id AND je.id = jl.entry_id
     JOIN account a ON a.tenant_id = jl.tenant_id AND a.id = jl.account_id
     WHERE jl.tenant_id = :t AND je.status = 'posted' AND a.number = '1200'`, [], 0);
  assert.equal(inventoryGl, pos.total_value, 'and the ledger says the same');
  assert.equal(gl.tieOuts(f.repo).find((x) => x.name === 'Inventory').difference, 0);
  assert.equal(gl.integrityCheck(f.repo).ok, true);
});

test('selling imported stock relieves it at the cost it was carried at', () => {
  const f = freshTenant();
  f.tx(() => f.repo.exec(
    `INSERT INTO exchange_rate (tenant_id, from_currency, to_currency, rate_date, rate) VALUES (:t,?,?,?,?)`,
    ['EUR', 'USD', '2026-01-01', 1.25]));
  const acct = (n) => f.repo.queryOne('SELECT * FROM account WHERE tenant_id = :t AND number = ?', [n]);
  const vendor = f.tx(() => entities.createVendor(f.repo, { name: 'Continental Parts GmbH', subsidiary_id: f.subsidiaryId, currency: 'EUR' }));
  const item = f.tx(() => inv.createItem(f.repo, {
    sku: 'EU-WIDGET', name: 'Imported widget', type: 'inventory', base_price: 400, standard_cost: 100,
  }));
  f.tx(() => T.createTxn(f.repo, 'VENDOR_BILL', {
    entity_id: vendor.id, subsidiary_id: f.subsidiaryId, txn_date: '2026-01-01', currency: 'EUR',
    location_id: f.location.id, lines: [{ item_id: item.id, quantity: 10, unit_price: 100 }],
  }));

  const customer = f.tx(() => entities.createCustomer(f.repo, { name: 'Domestic Inc', subsidiary_id: f.subsidiaryId }));
  const order = f.tx(() => T.createTxn(f.repo, 'SALES_ORDER', {
    entity_id: customer.id, subsidiary_id: f.subsidiaryId, txn_date: '2026-01-05',
    location_id: f.location.id, lines: [{ item_id: item.id, quantity: 4, unit_price: 400 }],
  }));
  f.tx(() => T.transform(f.repo, order.id, 'FULFILLMENT', {}));

  const cogs = f.repo.scalar(
    `SELECT COALESCE(SUM(jl.base_debit - jl.base_credit), 0) v FROM journal_line jl
     JOIN journal_entry je ON je.tenant_id = jl.tenant_id AND je.id = jl.entry_id
     JOIN account a ON a.tenant_id = jl.tenant_id AND a.id = jl.account_id
     WHERE jl.tenant_id = :t AND je.status = 'posted' AND a.number = '5010'`, [], 0);
  assert.equal(cogs, Money.parse(500), 'four at $125, not four at €100');
  assert.equal(gl.tieOuts(f.repo).find((x) => x.name === 'Inventory').difference, 0);
  assert.equal(gl.integrityCheck(f.repo).ok, true);
});
