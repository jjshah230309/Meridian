// The customisation engine and the numeric primitives underneath it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshTenant, DATE } from './helpers.mjs';
import { compile, evalSafe, validate, test as exprTest, ExprError } from '../src/core/expr.mjs';
import { Money, Qty, round } from '../src/core/util.mjs';
import { Router } from '../src/core/http.mjs';
import * as platform from '../src/modules/platform.mjs';
import * as entities from '../src/modules/entities.mjs';
import * as inv from '../src/modules/inventory.mjs';
import * as T from '../src/modules/txn.mjs';
import * as reports from '../src/modules/reports.mjs';

// ------------------------------------------------------------- money
test('money parses and formats without float drift', () => {
  assert.equal(Money.parse(1234.56), 123456);
  assert.equal(Money.parse('1,234.56'), 123456);
  assert.equal(Money.parse('$1234.56'), 123456);
  assert.equal(Money.parse(0.1) + Money.parse(0.2), Money.parse(0.3), '0.1 + 0.2 must equal 0.3');
  assert.equal(Money.parse(''), 0);
  assert.equal(Money.parse(null), 0);
  assert.equal(Money.parse(-99.995), -10000, 'half away from zero');
});

test('percentage and conversion round exactly once', () => {
  assert.equal(Money.pct(10000, 7.25), 725);
  assert.equal(Money.convert(10000, 1.2345), 12345);
  assert.equal(Qty.extend(Qty.parse(3), Money.parse(19.99)), Money.parse(59.97));
});

test('allocate splits an amount without losing or inventing a cent', () => {
  for (const [total, weights] of [[10000, [1, 1, 1]], [1, [1, 1]], [99999, [3, 5, 7, 11]], [-500, [2, 1]]]) {
    const parts = Money.allocate(total, weights);
    assert.equal(parts.reduce((a, b) => a + b, 0), total, `allocation of ${total} must be exact`);
  }
  assert.deepEqual(Money.allocate(10000, [1, 1, 1]), [3334, 3333, 3333]);
});

// -------------------------------------------------------- expressions
test('the expression language evaluates arithmetic, comparison and functions', () => {
  assert.equal(evalSafe('1 + 2 * 3'), 7);
  assert.equal(evalSafe('(1 + 2) * 3'), 9);
  assert.equal(evalSafe('total > 100', { total: 250 }), true);
  assert.equal(evalSafe('status in ["open","pending"]', { status: 'pending' }), true);
  assert.equal(evalSafe('IF(qty > 10, qty * 0.9, qty)', { qty: 20 }), 18);
  assert.equal(evalSafe('ROUND(MONEY(123456), 2)'), 1234.56);
  assert.equal(evalSafe('DAYS_BETWEEN("2026-01-01","2026-03-01")'), 59);
  assert.equal(evalSafe('CONCAT(UPPER(a), "-", b)', { a: 'inv', b: 42 }), 'INV-42');
  assert.equal(evalSafe('customer.name == "Acme"', { customer: { name: 'Acme' } }), true);
  assert.equal(evalSafe('a.b.c', { a: null }), null, 'missing paths are null, not an error');
});

test('FV and PV do not divide by zero at a 0% rate', () => {
  // (Math.pow(1+r, n) - 1) / r is 0/0 at r === 0 -- an interest-free
  // instalment plan, say -- and PMT already guarded that case; FV and PV did
  // not, and silently returned NaN into whatever posted the schedule.
  assert.equal(evalSafe('FV(0, 12, -100)'), -1200);
  assert.equal(evalSafe('PV(0, 12, -100)'), -1200);
  assert.equal(evalSafe('FV(0, 12, -100, 500)'), -700);
  assert.ok(Number.isFinite(evalSafe('FV(0.06, 12, -100)')), 'a real rate must still work');
});

test('the expression sandbox refuses prototype access and unknown functions', () => {
  assert.throws(() => compile('x.__proto__')({ x: {} }), ExprError);
  assert.throws(() => compile('constructor')({}), ExprError);
  assert.throws(() => compile('x.constructor.name')({ x: {} }), ExprError);
  assert.throws(() => compile('EVAL("1")')({}), /Unknown function/);
  // Host globals are simply not in scope: they resolve to null rather than
  // reaching anything real.
  assert.equal(evalSafe('process.exit', {}), null);
  assert.equal(evalSafe('globalThis', {}), null);
  // Host functions are never exposed as values.
  assert.equal(evalSafe('x.toString', { x: 'abc' }), null);
});

test('a formula cannot exhaust the stack or the heap', () => {
  // Both of these fit inside the 4,000-character source limit, and before the
  // depth and size caps the first overflowed the stack and the second aborted
  // the process outright -- from any signed-in user, via a workflow condition
  // or the expression validator.
  const deep = '('.repeat(1800) + '1' + ')'.repeat(1800);
  assert.throws(() => compile(deep), /nested too deeply/);

  let bomb = `"${'a'.repeat(64)}"`;
  for (let i = 0; i < 40; i++) bomb = `REPLACE(${bomb},"a","aa")`;
  assert.throws(() => compile(bomb)({}), /would build a string/);

  // A formula of ordinary size is untouched by any of it.
  assert.equal(compile(`CONCAT("${'x'.repeat(2000)}", "y")`)({}).length, 2001);
  assert.equal(compile('REPLACE("a-b-c", "-", " ")')({}), 'a b c');
});

test('a field named after an Object property is still just a field', () => {
  // KEYWORDS used to be a plain object, so the word "constructor" resolved up
  // the prototype chain and the tokenizer emitted a token whose type was a
  // native function.
  assert.throws(() => compile('x.constructor')({ x: {} }), /Illegal property/);
  assert.throws(() => compile('x.__proto__')({ x: {} }), /Illegal property/);
  assert.equal(compile('toString')({ toString: 'a value' }), 'a value');
  assert.equal(compile('r.valueOf')({ r: { valueOf: 7 } }), 7);
});

test('malformed expressions are reported, not thrown at runtime', () => {
  assert.equal(validate('1 +').ok, false);
  assert.equal(validate('total > 100').ok, true);
  assert.equal(validate('').ok, true, 'blank means "always"');
  assert.equal(exprTest('', {}), true);
});

test('expression evaluation is bounded', () => {
  const deep = '1' + '+1'.repeat(9000);
  assert.throws(() => compile(deep)({}), /too long|step budget/);
});

// ------------------------------------------------------------ router
test('the router matches parameters and rejects near-misses', () => {
  const r = new Router();
  r.get('/api/v1/records/:type', () => 'list');
  r.get('/api/v1/records/:type/:id', () => 'one');
  r.post('/api/v1/txn/:id/transform/:target', () => 'xf');

  assert.deepEqual(r.match('GET', '/api/v1/records/invoice').params, { type: 'invoice' });
  assert.deepEqual(r.match('GET', '/api/v1/records/invoice/01ABC').params, { type: 'invoice', id: '01ABC' });
  assert.deepEqual(r.match('POST', '/api/v1/txn/01A/transform/INVOICE').params, { id: '01A', target: 'INVOICE' });
  assert.equal(r.match('GET', '/api/v1/nothing'), null);
  assert.ok(r.match('DELETE', '/api/v1/records/invoice').methodNotAllowed);
  assert.equal(r.match('GET', '/api/v1/records/a/b/c'), null, 'extra segments must not match');
});

// ---------------------------------------------------- custom fields
test('custom fields validate their values and compute formulas', () => {
  const f = freshTenant();
  f.tx(() => {
    platform.createCustomField(f.repo, {
      record_type: 'customer', name: 'tier', label: 'Tier', type: 'select',
      options: ['Gold', 'Silver'], required: 1,
    });
    platform.createCustomField(f.repo, {
      record_type: 'customer', name: 'greeting', label: 'Greeting', type: 'formula',
      formula: 'CONCAT("Hello ", name)',
    });
  });

  assert.throws(() => platform.validateCustom(f.repo, 'customer', { tier: 'Bronze' }), /must be one of/);
  assert.throws(() => platform.validateCustom(f.repo, 'customer', {}), /Tier is required/);
  assert.deepEqual(platform.validateCustom(f.repo, 'customer', { tier: 'Gold' }), { tier: 'Gold' });

  const customer = f.tx(() => entities.createCustomer(f.repo, { name: 'Acme', custom: { tier: 'Gold' } }));
  const decorated = platform.decorateCustom(f.repo, 'customer', f.repo.get('customer', customer.id));
  assert.equal(decorated.custom.greeting, 'Hello Acme');
});

test('a money custom field on a customer is stored scaled, and a later patch does not blank the rest', () => {
  // createCustomer/updateCustomer wrote `custom` straight from the caller,
  // skipping platform.validateCustom entirely -- unlike every other write
  // path (records.mjs's genericCreate/genericUpdate, customrecords.mjs).
  // A money/qty field went in unscaled, and an update replaced the whole
  // blob instead of merging onto it.
  const f = freshTenant();
  f.tx(() => {
    platform.createCustomField(f.repo, { record_type: 'customer', name: 'bonus', label: 'Signing bonus', type: 'money' });
    platform.createCustomField(f.repo, { record_type: 'customer', name: 'tier', label: 'Tier', type: 'text' });
  });
  const customer = f.tx(() => entities.createCustomer(f.repo, {
    name: 'Acme', custom: { bonus: 250, tier: 'gold' },
  }));
  assert.equal(f.repo.get('customer', customer.id).custom.bonus, 25000, 'a money field is stored in minor units, like every other money field');

  const updated = f.tx(() => entities.updateCustomer(f.repo, customer.id, { custom: { tier: 'platinum' } }));
  assert.equal(updated.custom.tier, 'platinum');
  assert.equal(updated.custom.bonus, 25000, 'a patch naming one custom field must not blank the others');
});

test('a custom field cannot shadow a standard field or be renamed', () => {
  const f = freshTenant();
  assert.throws(() => f.tx(() => platform.createCustomField(f.repo, {
    record_type: 'customer', name: 'name', label: 'Name', type: 'text',
  })), /already a standard field/);

  const cf = f.tx(() => platform.createCustomField(f.repo, {
    record_type: 'customer', name: 'ref_code', label: 'Ref', type: 'text',
  }));
  assert.throws(() => f.tx(() => platform.updateCustomField(f.repo, cf.id, { name: 'other' })), /cannot be renamed/);
});

test('a broken formula is rejected at definition time', () => {
  const f = freshTenant();
  assert.throws(() => f.tx(() => platform.createCustomField(f.repo, {
    record_type: 'customer', name: 'bad', label: 'Bad', type: 'formula', formula: 'IF(',
  })), /Expected|Unexpected/);
});

// -------------------------------------------------------- workflows
test('a before_update workflow can block a save', () => {
  const f = freshTenant();
  f.tx(() => platform.createWorkflow(f.repo, {
    name: 'Require category', record_type: 'customer', trigger: 'before_update',
    condition: 'ISBLANK(category)', status: 'released',
    actions: [{ type: 'block', message: 'Every customer needs a category.' }],
  }));
  const record = { id: 'X', name: 'Acme', category: '' };
  const outcome = platform.dispatch(f.repo, 'customer', 'before_update', record, { before: record, mutable: record });
  assert.equal(outcome.blocked, 'Every customer needs a category.');
});

test('a workflow can set a field, and its condition sees money in natural units', () => {
  const f = freshTenant();
  f.tx(() => platform.createWorkflow(f.repo, {
    name: 'Flag big deals', record_type: 'invoice', trigger: 'before_create',
    condition: 'total > 10000', status: 'released',
    actions: [{ type: 'set_field', field: 'memo', value: '=CONCAT("LARGE: ", TEXT(total))' }],
  }));
  const mutable = { total: Money.parse(25000), memo: '' };
  const outcome = platform.dispatch(f.repo, 'invoice', 'before_create', mutable, { mutable });
  assert.equal(outcome.blocked, null);
  assert.equal(mutable.memo, 'LARGE: 25000', 'money is exposed as 25000, not 2500000');
});

test('a workflow whose condition throws is logged and skipped, not fatal', () => {
  const f = freshTenant();
  const wf = f.tx(() => platform.createWorkflow(f.repo, {
    name: 'Broken', record_type: 'customer', trigger: 'after_create',
    condition: 'UNKNOWN_FN(1)', status: 'released',
    actions: [{ type: 'log', message: 'never' }],
  }));
  const outcome = platform.dispatch(f.repo, 'customer', 'after_create', { id: 'X', name: 'A' });
  assert.equal(outcome.blocked, null);
  const logs = f.repo.query('SELECT * FROM workflow_log WHERE tenant_id = :t AND workflow_id = ?', [wf.id]);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].result, 'error', 'a broken condition is recorded as an error');
  assert.match(logs[0].message, /Unknown function/);
});

test('a draft workflow does not run', () => {
  const f = freshTenant();
  f.tx(() => platform.createWorkflow(f.repo, {
    name: 'Draft rule', record_type: 'customer', trigger: 'before_create',
    condition: '', status: 'draft',
    actions: [{ type: 'block', message: 'nope' }],
  }));
  assert.equal(platform.dispatch(f.repo, 'customer', 'before_create', {}, { mutable: {} }).blocked, null);
});

test('server scripts are disabled unless explicitly enabled', async () => {
  const f = freshTenant();
  assert.equal(platform.scriptsEnabled(), false);
  await assert.rejects(
    () => platform.runServerScript(f.repo, { name: 'x', code: '1', timeout_ms: 50 }, {}),
    /disabled/);
});

// ------------------------------------------------------------ pricing
test('pricing rules apply in priority order and a non-stackable match wins', () => {
  const f = freshTenant();
  const item = f.tx(() => inv.createItem(f.repo, { sku: 'X1', name: 'Thing', base_price: 100 }));
  const customer = f.tx(() => entities.createCustomer(f.repo, { name: 'Edu Buyer', category: 'Education' }));
  f.tx(() => {
    f.repo.insert('pricing_rule', { name: 'Bulk 25+', priority: 10, condition: 'quantity >= 25', action: 'discount_pct', value: 12, stackable: 0, active: 1, created_at: new Date().toISOString() });
    f.repo.insert('pricing_rule', { name: 'Education', priority: 20, condition: 'customer.category == "Education"', action: 'discount_pct', value: 15, stackable: 0, active: 1, created_at: new Date().toISOString() });
  });

  const small = T.applyPricingRules(f.repo, { item, customer, line: {}, txn: { txn_date: DATE }, unit_price: Money.parse(100), quantity: Qty.parse(1) });
  assert.equal(small.discount_pct, 15, 'education discount applies at any quantity');

  const bulk = T.applyPricingRules(f.repo, { item, customer, line: {}, txn: { txn_date: DATE }, unit_price: Money.parse(100), quantity: Qty.parse(30) });
  assert.equal(bulk.discount_pct, 12, 'the higher-priority bulk rule wins outright');
  assert.deepEqual(bulk.applied, ['Bulk 25+']);
});

test('an approval rule routes a matching order and blocks posting until approved', () => {
  const f = freshTenant();
  const customer = f.tx(() => entities.createCustomer(f.repo, { name: 'Big Co' }));
  const item = f.tx(() => inv.createItem(f.repo, { sku: 'S1', name: 'Service', type: 'service', base_price: 1000 }));
  f.tx(() => f.repo.insert('approval_rule', {
    name: 'Over 5k', txn_type: 'SALES_ORDER', condition: 'total > 5000',
    sequence: 1, active: 1, created_at: new Date().toISOString(),
  }));

  const small = f.tx(() => T.createTxn(f.repo, 'SALES_ORDER', {
    entity_id: customer.id, txn_date: DATE, lines: [{ item_id: item.id, quantity: 1 }],
  }));
  assert.equal(small.approval_status, 'not_required');

  const big = f.tx(() => T.createTxn(f.repo, 'SALES_ORDER', {
    entity_id: customer.id, txn_date: DATE, lines: [{ item_id: item.id, quantity: 10 }],
  }));
  assert.equal(big.approval_status, 'pending');
  assert.equal(big.status, 'pending_approval');

  const approved = f.tx(() => T.approveTxn(f.repo, big.id));
  assert.equal(approved.approval_status, 'approved');
  assert.equal(approved.status, 'open');
});

// ------------------------------------------------------------- aging
test('aging bands place documents in the bucket their label claims', () => {
  const f = freshTenant();
  const customer = f.tx(() => entities.createCustomer(f.repo, { name: 'Slow Payer', terms: 'NET30' }));
  const item = f.tx(() => inv.createItem(f.repo, { sku: 'S1', name: 'Service', type: 'service', base_price: 100 }));

  // Invoice dates chosen so the due dates land 5, 45 and 100 days overdue.
  const asOf = '2026-06-30';
  for (const [date, expectBucket] of [['2026-05-26', 1], ['2026-04-16', 2], ['2026-01-21', 4]]) {
    f.tx(() => T.createTxn(f.repo, 'INVOICE', {
      entity_id: customer.id, txn_date: date, lines: [{ item_id: item.id, quantity: 1 }],
    }));
  }
  const aging = reports.arAging(f.repo, { asOf });
  assert.deepEqual(aging.bucket_labels, ['Current', '1–30', '31–60', '61–90', '90+']);
  const docs = aging.entities[0].documents;
  const byOverdue = Object.fromEntries(docs.map((d) => [d.days_overdue, d.bucket]));
  assert.equal(byOverdue[5], 1, '5 days overdue belongs in 1–30');
  assert.equal(byOverdue[45], 2, '45 days overdue belongs in 31–60');
  assert.equal(byOverdue[130], 4, '130 days overdue belongs in 90+');
  assert.equal(aging.total, aging.bucket_totals.reduce((a, b) => a + b, 0));
});

test('the financial statements agree with each other', () => {
  const f = freshTenant();
  const customer = f.tx(() => entities.createCustomer(f.repo, { name: 'Acme' }));
  const item = f.tx(() => inv.createItem(f.repo, { sku: 'S1', name: 'Service', type: 'service', base_price: 1000 }));
  f.tx(() => T.createTxn(f.repo, 'INVOICE', {
    entity_id: customer.id, txn_date: DATE, lines: [{ item_id: item.id, quantity: 3 }],
  }));

  const bs = reports.balanceSheet(f.repo, { asOf: '2026-12-31' });
  assert.ok(bs.balanced, `balance sheet out by ${bs.out_of_balance}`);
  const tb = reports.trialBalance(f.repo, { to: '2026-12-31' });
  assert.ok(tb.balanced, 'trial balance must balance');
  const pl = reports.incomeStatement(f.repo, { from: '2026-01-01', to: '2026-12-31' });
  assert.equal(pl.revenue.total, Money.parse(3000));
  assert.equal(bs.equity.current_year_earnings, pl.net_income, 'balance sheet folds in current-year P&L');
});

test('month-to-date reporting includes the current, unclosed period', () => {
  const f = freshTenant();
  const customer = f.tx(() => entities.createCustomer(f.repo, { name: 'Acme' }));
  const item = f.tx(() => inv.createItem(f.repo, { sku: 'S1', name: 'Service', type: 'service', base_price: 500 }));
  f.tx(() => T.createTxn(f.repo, 'INVOICE', {
    entity_id: customer.id, txn_date: '2026-06-03', lines: [{ item_id: item.id, quantity: 2 }],
  }));
  // A window that stops mid-period must still see the posting.
  const partial = reports.incomeStatement(f.repo, { from: '2026-06-01', to: '2026-06-10' });
  assert.equal(partial.revenue.total, Money.parse(1000));
  const beforeIt = reports.incomeStatement(f.repo, { from: '2026-06-01', to: '2026-06-02' });
  assert.equal(beforeIt.revenue.total, 0, 'and must respect the end date');
});

// ---------------------------------------------------------------- registry
// Every field the metadata registry says is writable has to actually be
// writable. Hand-kept allow-lists in the entity modules used to drift from
// the registry: a field appeared on the form, saved without complaint, and
// silently did nothing.
test('every writable field on customer and vendor really saves', async () => {
  const meta = await import('../src/modules/meta.mjs');
  const entities = await import('../src/modules/entities.mjs');
  const f = freshTenant();

  const SAMPLE = {
    text: 'x', longtext: 'x', email: 'a@b.test', phone: '+1 555 0100', url: 'https://example.test',
    number: 3, money: 12.5, percent: 4, checkbox: 1, date: '2026-03-04', json: { line1: 'A' },
  };
  const employee = f.tx(() => f.repo.insert('employee', {
    id: 'EMP1', employee_no: 'E0001', first_name: 'Sam', last_name: 'Reed',
    email: 'sam@test.local', hire_date: '2026-01-01', status: 'active',
    subsidiary_id: f.subsidiaryId, currency: 'USD',
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  }));

  for (const [type, make, update] of [
    ['customer', entities.createCustomer, entities.updateCustomer],
    ['vendor', entities.createVendor, entities.updateVendor],
  ]) {
    const record = f.tx(() => make(f.repo, { name: `Registry ${type}`, subsidiary_id: f.subsidiaryId }));
    const patch = {};
    const expected = {};
    for (const field of meta.getMeta(type).fields) {
      if (field.readOnly || field.name === 'custom') continue;
      // Fields with consequences of their own are exercised elsewhere.
      if (['currency', 'subsidiary_id', 'status', 'name', 'parent_id', 'entity_no'].includes(field.name)) continue;
      let value = field.options ? field.options[0] : SAMPLE[field.type];
      if (field.ref === 'employee') value = employee;
      else if (field.ref) continue;
      if (value === undefined) continue;
      patch[field.name] = value;
      expected[field.name] = meta.coerce(field, value);
    }
    const after = f.tx(() => update(f.repo, record.id, patch));
    for (const [name, want] of Object.entries(expected)) {
      assert.deepEqual(after[name], want, `${type}.${name} did not save`);
    }
  }
});

test('"is any of" on a money field compares dollars, like eq and between do', () => {
  // eq and between both coerce the filter value (major units -> the stored
  // minor-unit integer) before binding it; the "in" branch skipped that step
  // and bound the raw major-unit value, so it could never match.
  const f = freshTenant();
  f.tx(() => entities.createCustomer(f.repo, { name: 'Acme Co', credit_limit: 5000, subsidiary_id: f.subsidiaryId }));

  const eq = platform.runSearch(f.repo, 'customer', { filters: [{ field: 'credit_limit', op: 'eq', value: 5000 }] });
  assert.equal(eq.total, 1);

  const isAnyOf = platform.runSearch(f.repo, 'customer', { filters: [{ field: 'credit_limit', op: 'in', value: [5000] }] });
  assert.equal(isAnyOf.total, 1, '"is any of" must match the same row eq does');
});
