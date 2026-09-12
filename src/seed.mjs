// Meridian ERP :: seed
// Builds a demo company with a realistic six months of trading history so
// every screen has something true to show. Deterministic: the same seed
// produces the same books, which makes the numbers in the docs reproducible.
import { transaction, Repo } from './core/db.mjs';
import { ulid, nowIso, today, addDays, addMonths, startOfMonth, endOfMonth, Money, Qty } from './core/util.mjs';
import { provisionTenant, postingAccounts } from './modules/setup.mjs';
import * as gl from './modules/gl.mjs';
import * as inv from './modules/inventory.mjs';
import * as entities from './modules/entities.mjs';
import * as T from './modules/txn.mjs';
import * as crm from './modules/crm.mjs';
import * as hr from './modules/hr.mjs';
import * as platform from './modules/platform.mjs';
import * as bank from './modules/bank.mjs';
import * as projects from './modules/projects.mjs';
import * as manufacturing from './modules/manufacturing.mjs';
import * as warehouse from './modules/warehouse.mjs';
import * as service from './modules/service.mjs';
import * as assets from './modules/assets.mjs';
import * as budget from './modules/budget.mjs';
import * as commerce from './modules/commerce.mjs';
import * as workforce from './modules/workforce.mjs';
import * as schedules from './modules/schedules.mjs';
import * as recurring from './modules/recurring.mjs';
import * as revaluation from './modules/revaluation.mjs';
import * as collections from './modules/collections.mjs';
import * as payruns from './modules/payruns.mjs';
import * as tax from './modules/tax.mjs';
import * as allocations from './modules/allocations.mjs';
import * as costing from './modules/costing.mjs';
import * as subscriptions from './modules/subscriptions.mjs';
import * as intercompany from './modules/intercompany.mjs';
import * as customrecords from './modules/customrecords.mjs';
import * as books from './modules/books.mjs';
import * as records from './modules/records.mjs';

/** Deterministic PRNG (mulberry32) so the demo books never shift. */
function rng(seed = 20260101) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEMO = {
  email: 'admin@northwind.test',
  password: 'Northwind-Demo-2026',
  company: 'Northwind Trading Co.',
};

/** Build the demo company from nothing: its own tenant, then the history. */
export function seedDemo(db, { force = false } = {}) {
  const existing = db.prepare('SELECT COUNT(*) c FROM tenant').get().c;
  if (existing > 0 && !force) return null;
  if (existing > 0 && force) {
    const t = db.prepare('SELECT * FROM tenant ORDER BY created_at LIMIT 1').get();
    if (t) return { name: t.name, email: DEMO.email, password: DEMO.password, existing: true };
  }

  const provisioned = transaction(db, () => provisionTenant(db, {
    name: DEMO.company, slug: 'northwind', ownerEmail: DEMO.email, ownerName: 'Dana Whitfield',
    ownerPassword: DEMO.password, baseCurrency: 'USD', country: 'US',
    fiscalYear: Number(today().slice(0, 4)),
  }));
  populate(db, provisioned, 'Dana Whitfield');
  return { name: DEMO.company, email: DEMO.email, password: DEMO.password };
}

/**
 * Load the same trading history into a company that already exists -- what
 * the first-run wizard calls when someone ticks "include sample data". The
 * company keeps its own name, currency and administrator; only the customers,
 * stock and transactions are invented.
 */
export function seedSampleData(db, tenantId) {
  const tenant = db.prepare('SELECT * FROM tenant WHERE id = ?').get(tenantId);
  if (!tenant) throw new Error(`Company ${tenantId} was not found`);

  const owner = db.prepare(
    'SELECT * FROM app_user WHERE tenant_id = ? ORDER BY is_owner DESC, created_at LIMIT 1').get(tenantId);
  if (!owner) throw new Error('That company has no administrator to attribute the sample data to');

  const repo = new Repo(db, tenantId, { user: { id: owner.id, name: owner.name } });
  const subsidiary = repo.queryOne(
    'SELECT id FROM subsidiary WHERE tenant_id = :t AND parent_id IS NULL ORDER BY created_at LIMIT 1');
  const roleIds = Object.fromEntries(
    repo.query('SELECT id, name FROM role WHERE tenant_id = :t').map((r) => [r.name, r.id]));

  populate(db, {
    tenant, ownerId: owner.id, subsidiaryId: subsidiary.id, roleIds,
  }, owner.name);
  return { name: tenant.name };
}

/** Everything after provisioning: six months of trading for one tenant. */
function populate(db, provisioned, ownerName) {
  const R = rng();
  const pick = (arr) => arr[Math.floor(R() * arr.length)];
  const between = (lo, hi) => lo + Math.floor(R() * (hi - lo + 1));
  const now = today();
  const monthsBack = (n) => startOfMonth(addMonths(now, -n));

  const repo = new Repo(db, provisioned.tenant.id, { user: { id: provisioned.ownerId, name: ownerName } });
  const acc = postingAccounts(repo);
  const usSub = provisioned.subsidiaryId;

  // ================================================== structure
  const built = transaction(db, () => {
    // Named after whichever company this is being loaded into, so sample data
    // in "Acme Ltd" does not sprout a subsidiary belonging to someone else.
    const parentName = provisioned.tenant.name.replace(/\s*(Co\.|Inc\.?|Ltd\.?|LLC|Limited)$/i, '').trim();
    const ukSub = repo.insert('subsidiary', {
      id: ulid(), name: `${parentName} UK Ltd`, legal_name: `${parentName} UK Limited`,
      parent_id: usSub, currency: 'GBP', country: 'GB', tax_number: 'GB123456789',
      address: { line1: '18 Prospect Row', city: 'Bristol', postcode: 'BS1 4QT', country: 'GB' },
      is_elimination: 0, active: 1, created_at: nowIso(),
    });

    // A euro account for the euro suppliers. Cash held in a currency that is
    // not the reporting one is the third exposure a revaluation has to cover.
    repo.insert('bank_account', {
      id: ulid(), name: 'Euro Account', account_id: acc.bank, subsidiary_id: usSub,
      bank_name: 'Continental Bank', number_masked: '••4411', routing_masked: '',
      currency: 'EUR', active: 1, created_at: nowIso(),
    });

    // FX rates for the last 8 months so multi-currency posting works. Both
    // ends of every month: a period-end revaluation reads the closing rate,
    // and the first of the month is no use to it.
    for (let i = 8; i >= 0; i--) {
      const first = startOfMonth(addMonths(now, -i));
      for (const d of [first, endOfMonth(first)]) {
        repo.exec(`INSERT INTO exchange_rate (tenant_id, from_currency, to_currency, rate_date, rate, source)
                   VALUES (:t,?,?,?,?,'seed') ON CONFLICT DO NOTHING`, ['GBP', 'USD', d, 1.24 + R() * 0.06]);
        repo.exec(`INSERT INTO exchange_rate (tenant_id, from_currency, to_currency, rate_date, rate, source)
                   VALUES (:t,?,?,?,?,'seed') ON CONFLICT DO NOTHING`, ['EUR', 'USD', d, 1.06 + R() * 0.05]);
        // The cross rate as well: a euro balance in the sterling entity has to
        // be convertible without going via dollars.
        repo.exec(`INSERT INTO exchange_rate (tenant_id, from_currency, to_currency, rate_date, rate, source)
                   VALUES (:t,?,?,?,?,'seed') ON CONFLICT DO NOTHING`, ['EUR', 'GBP', d, 0.84 + R() * 0.04]);
      }
    }

    const departments = {};
    for (const name of ['Executive', 'Sales', 'Marketing', 'Operations', 'Finance', 'Customer Success', 'Engineering']) {
      departments[name] = repo.insert('department', { id: ulid(), name, parent_id: null, subsidiary_id: null, active: 1 });
    }

    const locations = {
      MAIN: repo.queryOne("SELECT id FROM location WHERE tenant_id = :t AND code = 'MAIN'").id,
      WEST: repo.insert('location', {
        id: ulid(), code: 'WEST', name: 'West Coast DC', subsidiary_id: usSub,
        address: { line1: '2400 Harbor Blvd', city: 'Oakland', state: 'CA', postcode: '94607', country: 'US' },
        type: 'warehouse', makes_commitments: 1, active: 1, created_at: nowIso(),
      }),
      UK: repo.insert('location', {
        id: ulid(), code: 'UK1', name: 'Bristol Depot', subsidiary_id: ukSub,
        address: { line1: 'Unit 4, Avon Park', city: 'Bristol', postcode: 'BS2 0RR', country: 'GB' },
        type: 'warehouse', makes_commitments: 1, active: 1, created_at: nowIso(),
      }),
    };
    return { ukSub, departments, locations };
  });
  const { ukSub, departments, locations } = built;

  // ================================================== people
  const employees = transaction(db, () => {
    const roster = [
      ['Dana', 'Whitfield', 'Chief Executive Officer', 'Executive', null, 285000, 'salary'],
      ['Marcus', 'Hale', 'VP Finance', 'Finance', 'Dana Whitfield', 205000, 'salary'],
      ['Priya', 'Raman', 'VP Sales', 'Sales', 'Dana Whitfield', 215000, 'salary'],
      ['Tomas', 'Bergstrom', 'VP Operations', 'Operations', 'Dana Whitfield', 198000, 'salary'],
      ['Amara', 'Osei', 'Controller', 'Finance', 'Marcus Hale', 152000, 'salary'],
      ['Jonah', 'Petrov', 'Senior Accountant', 'Finance', 'Amara Osei', 108000, 'salary'],
      ['Lena', 'Fischer', 'AR Specialist', 'Finance', 'Amara Osei', 78000, 'salary'],
      ['Rafael', 'Domingo', 'AP Specialist', 'Finance', 'Amara Osei', 76000, 'salary'],
      ['Yuki', 'Tanaka', 'Enterprise Account Executive', 'Sales', 'Priya Raman', 132000, 'salary'],
      ['Chidi', 'Okonkwo', 'Account Executive', 'Sales', 'Priya Raman', 118000, 'salary'],
      ['Sofia', 'Marchetti', 'Account Executive', 'Sales', 'Priya Raman', 116000, 'salary'],
      ['Ben', 'Ashworth', 'Sales Development Rep', 'Sales', 'Priya Raman', 72000, 'salary'],
      ['Nadia', 'Karim', 'Marketing Manager', 'Marketing', 'Dana Whitfield', 124000, 'salary'],
      ['Ivan', 'Kovacs', 'Warehouse Manager', 'Operations', 'Tomas Bergstrom', 92000, 'salary'],
      ['Grace', 'Lindqvist', 'Inventory Analyst', 'Operations', 'Ivan Kovacs', 84000, 'salary'],
      ['Owen', 'Brady', 'Warehouse Associate', 'Operations', 'Ivan Kovacs', 27, 'hourly'],
      ['Mei', 'Chen', 'Customer Success Manager', 'Customer Success', 'Dana Whitfield', 106000, 'salary'],
      ['Theo', 'Alvarez', 'Support Engineer', 'Customer Success', 'Mei Chen', 94000, 'salary'],
      ['Freya', 'Nilsen', 'Support Engineer', 'Customer Success', 'Mei Chen', 91000, 'salary'],
      ['Samuel', 'Adeyemi', 'Systems Engineer', 'Engineering', 'Tomas Bergstrom', 138000, 'salary'],
    ];
    const byName = {};
    for (const [first, last, title, dept, manager, pay, payType] of roster) {
      const e = hr.createEmployee(repo, {
        first_name: first, last_name: last, title,
        email: `${first.toLowerCase()}.${last.toLowerCase()}@northwind.test`,
        work_phone: `+1 415 555 ${String(between(1000, 9999))}`,
        department_id: departments[dept], manager_id: manager ? byName[manager] : null,
        subsidiary_id: usSub, location_id: locations.MAIN,
        hire_date: addDays(now, -between(120, 2100)),
        employment_type: payType === 'hourly' ? 'part_time' : 'full_time',
        pay_type: payType, pay_rate: pay, pay_frequency: payType === 'hourly' ? 'biweekly' : 'monthly',
        standard_hours: payType === 'hourly' ? 24 : 40,
        is_sales_rep: dept === 'Sales', is_manager: !!roster.find((x) => x[4] === `${first} ${last}`),
        pto_balance_hours: between(20, 160),
      });
      byName[`${first} ${last}`] = e.id;
    }
    return byName;
  });
  const salesReps = ['Yuki Tanaka', 'Chidi Okonkwo', 'Sofia Marchetti'].map((n) => employees[n]);

  // ================================================== catalogue
  const items = transaction(db, () => {
    const catalogue = [
      ['NW-CTR-100', 'Cortex Router 100', 'Networking', 'inventory', 1899, 940, 'EA'],
      ['NW-CTR-400', 'Cortex Router 400', 'Networking', 'inventory', 4250, 2180, 'EA'],
      ['NW-SWX-24', 'Switchbox 24-Port', 'Networking', 'inventory', 1150, 585, 'EA'],
      ['NW-SWX-48', 'Switchbox 48-Port', 'Networking', 'inventory', 2090, 1075, 'EA'],
      ['NW-APX-6', 'Access Point AX6', 'Wireless', 'inventory', 389, 172, 'EA'],
      ['NW-APX-6P', 'Access Point AX6 Pro', 'Wireless', 'inventory', 629, 288, 'EA'],
      ['NW-FWL-200', 'Sentinel Firewall 200', 'Security', 'inventory', 3480, 1790, 'EA'],
      ['NW-FWL-500', 'Sentinel Firewall 500', 'Security', 'inventory', 7900, 4120, 'EA'],
      ['NW-CBL-C6A', 'Cat6A Patch Cable 3m', 'Cabling', 'inventory', 18, 5, 'EA'],
      ['NW-CBL-FIB', 'Fibre Patch LC-LC 5m', 'Cabling', 'inventory', 42, 14, 'EA'],
      ['NW-RCK-42U', '42U Server Rack', 'Racking', 'inventory', 1420, 720, 'EA'],
      ['NW-PDU-16', 'Managed PDU 16-Way', 'Racking', 'inventory', 690, 320, 'EA'],
      ['NW-SFP-10G', '10G SFP+ Module', 'Optics', 'inventory', 165, 62, 'EA'],
      ['NW-SFP-25G', '25G SFP28 Module', 'Optics', 'inventory', 310, 128, 'EA'],
      ['SVC-INSTALL', 'On-site Installation Day', 'Services', 'service', 1650, 0, 'DAY'],
      ['SVC-SUPPORT', 'Premium Support (annual)', 'Services', 'service', 4800, 0, 'YR'],
      ['SVC-AUDIT', 'Network Audit', 'Services', 'service', 3200, 0, 'EA'],
    ];
    const out = {};
    for (const [sku, name, category, type, price, cost, uom] of catalogue) {
      const it = inv.createItem(repo, {
        sku, name, category, type, uom, base_price: price, purchase_price: cost, standard_cost: cost,
        description: `${name} — ${category.toLowerCase()} line`,
        income_account_id: type === 'service' ? acc.service_revenue : acc.product_revenue,
        cogs_account_id: acc.cogs, asset_account_id: acc.inventory,
        lead_time_days: between(5, 21), barcode: `50${between(100000000, 999999999)}`,
      });
      out[sku] = it;
      if (type === 'inventory') {
        for (const loc of [locations.MAIN, locations.WEST]) {
          inv.position(repo, it.id, loc);
          repo.exec(`UPDATE item_location SET reorder_point = ?, preferred_stock_level = ?, safety_stock = ?, lead_time_days = ?
                     WHERE tenant_id = :t AND item_id = ? AND location_id = ?`,
            [Qty.parse(between(10, 40)), Qty.parse(between(80, 200)), Qty.parse(between(5, 15)), between(5, 21), it.id, loc]);
        }
      }
    }
    return out;
  });
  let stocked = Object.values(items).filter((i) => i.type === 'inventory');
  const services = Object.values(items).filter((i) => i.type === 'service');

  // ================================================== trading partners
  const { customers, vendors } = transaction(db, () => {
    const customerNames = [
      ['Halcyon Health Systems', 'Healthcare', 450000], ['Redwood School District', 'Education', 180000],
      ['Meridian Logistics Group', 'Logistics', 320000], ['Blue Harbor Financial', 'Financial Services', 600000],
      ['Copperfield Manufacturing', 'Manufacturing', 275000], ['Lantern Media Holdings', 'Media', 150000],
      ['Ashgrove Hotels', 'Hospitality', 210000], ['Vantage Legal LLP', 'Professional Services', 95000],
      ['Northstar Biotech', 'Life Sciences', 500000], ['Cascade Public Library', 'Public Sector', 70000],
      ['Ironbridge Energy', 'Energy', 380000], ['Summit Ridge Resorts', 'Hospitality', 165000],
      ['Larkspur Retail Group', 'Retail', 240000], ['Quayside Shipping', 'Logistics', 190000],
      ['Fernwood Property Trust', 'Real Estate', 130000], ['Beacon Insurance Mutual', 'Insurance', 420000],
      ['Thornton Aerospace', 'Aerospace', 700000], ['Pinehurst Community Bank', 'Financial Services', 260000],
      ['Willowbrook Clinics', 'Healthcare', 145000], ['Granite Peak Mining', 'Mining', 310000],
      ['Selkirk University', 'Education', 350000], ['Dovetail Design Studio', 'Creative', 55000],
      ['Marlowe Foods', 'Food & Beverage', 175000], ['Kestrel Air Services', 'Aviation', 290000],
    ];
    const cs = customerNames.map(([name, category, creditLimit], i) => entities.createCustomer(repo, {
      name, category, credit_limit: creditLimit,
      email: `accounts@${name.toLowerCase().replace(/[^a-z]/g, '').slice(0, 14)}.test`,
      phone: `+1 ${between(200, 799)} 555 ${between(1000, 9999)}`,
      website: `https://${name.toLowerCase().replace(/[^a-z]/g, '').slice(0, 16)}.test`,
      billing_address: {
        line1: `${between(100, 9800)} ${pick(['Market', 'Willow', 'Chestnut', 'Franklin', 'Harbor', 'Summit'])} ${pick(['St', 'Ave', 'Blvd'])}`,
        city: pick(['San Francisco', 'Portland', 'Denver', 'Austin', 'Chicago', 'Boston', 'Seattle']),
        state: pick(['CA', 'OR', 'CO', 'TX', 'IL', 'MA', 'WA']), postcode: String(between(10000, 99999)), country: 'US',
      },
      terms: pick(['NET30', 'NET30', 'NET30', 'NET45', 'NET15', 'DUE_ON_RECEIPT']),
      sales_rep_id: salesReps[i % salesReps.length],
      subsidiary_id: i % 6 === 0 ? ukSub : usSub,
      // Sterling customers sit in the sterling entity, where sterling is the
      // base currency and nothing moves. The euro ones are billed out of the
      // US entity, which is where a rate change actually shows up.
      currency: i % 6 === 0 ? 'GBP' : (i % 7 === 3 ? 'EUR' : 'USD'),
      // A rate that is actually a rate: without one the ledger carries no tax
      // and the return has nothing to show. Education and healthcare are the
      // usual exemptions, and having a couple of them makes the point.
      tax_code: ['Education', 'Healthcare'].includes(category) ? 'EXEMPT'
        : i % 6 === 0 ? 'VAT20' : 'CA_SALES',
      status: 'active', source: pick(['web', 'referral', 'event', 'outbound', 'partner']),
    }));

    for (const c of cs.slice(0, 16)) {
      const first = pick(['Alex', 'Jordan', 'Sam', 'Riley', 'Casey', 'Morgan', 'Avery', 'Quinn', 'Rowan', 'Emerson']);
      const last = pick(['Hartley', 'Nakamura', 'Duval', 'Okafor', 'Sorensen', 'Barros', 'Whitlock', 'Ferreira']);
      entities.createContact(repo, {
        first_name: first, last_name: last, title: pick(['IT Director', 'CFO', 'Procurement Manager', 'Head of Infrastructure', 'Operations Lead']),
        email: `${first.toLowerCase()}.${last.toLowerCase()}@${c.name.toLowerCase().replace(/[^a-z]/g, '').slice(0, 14)}.test`,
        phone: `+1 ${between(200, 799)} 555 ${between(1000, 9999)}`,
        company_type: 'customer', company_id: c.id, is_primary: 1,
      });
    }

    const vs = [
      ['Cortex Systems Inc', 'Hardware'], ['Switchline Distribution', 'Hardware'],
      ['Aurora Optics Ltd', 'Components'], ['Ironclad Racking Co', 'Hardware'],
      ['CablePro Wholesale', 'Components'], ['Sentinel Security Devices', 'Hardware'],
      ['Pacific Freight Partners', 'Logistics'], ['Brightline Facilities', 'Services'],
      ['Ledgerworks Advisory', 'Professional'], ['Vertex Cloud Services', 'Software'],
      ['Metro Power & Light', 'Utilities'], ['Sterling Office Supply', 'Office'],
    ].map(([name, category]) => entities.createVendor(repo, {
      name, category, email: `ap@${name.toLowerCase().replace(/[^a-z]/g, '').slice(0, 14)}.test`,
      phone: `+1 ${between(200, 799)} 555 ${between(1000, 9999)}`,
      terms: pick(['NET30', 'NET30', 'NET45', 'NET15']),
      lead_time_days: between(5, 25),
      // A supplier without an address has nowhere for a remittance advice or
      // a purchase order to be sent.
      address: {
        line1: `${between(100, 9800)} ${pick(['Industrial', 'Commerce', 'Foundry', 'Wharf', 'Depot', 'Kiln'])} ${pick(['Way', 'Road', 'Park'])}`,
        city: pick(['San Jose', 'Newark', 'Reno', 'Memphis', 'Columbus', 'Tacoma', 'Phoenix']),
        state: pick(['CA', 'NJ', 'NV', 'TN', 'OH', 'WA', 'AZ']), postcode: String(between(10000, 99999)), country: 'US',
      },
      // Around a fifth of suppliers are the sort a 1099 has to be filed for:
      // consultants, contractors, professional services.
      is_1099: ['Professional', 'Services', 'Logistics'].includes(category) ? 1 : 0,
      tax_number: `${between(10, 99)}-${between(1000000, 9999999)}`,
      tax_code: category === 'Utilities' ? 'EXEMPT' : 'CA_SALES',
      currency: ['Logistics', 'Components'].includes(category) ? 'EUR' : 'USD',
      tax_form: category === 'Professional' ? '1099-MISC' : '1099-NEC',
      tax_form_box: category === 'Professional' ? '10' : '1',
    }));

    // Point each stocked item at a plausible supplier.
    const hwVendors = vs.filter((v) => ['Hardware', 'Components'].includes(v.category));
    for (const it of stocked) {
      inv.updateItem(repo, it.id, { preferred_vendor_id: pick(hwVendors).id });
    }
    return { customers: cs, vendors: vs };
  });
  // Re-read the catalogue now that preferred vendors have been assigned.
  stocked = repo.query("SELECT * FROM item WHERE tenant_id = :t AND type IN ('inventory','assembly') ORDER BY sku");

  // ================================================== opening balances
  transaction(db, () => {
    gl.postJournal(repo, {
      subsidiary_id: usSub, txn_date: monthsBack(7), currency: 'USD',
      memo: 'Opening balances', source_type: 'manual',
      lines: [
        { account_id: acc.bank, debit: Money.parse(2400000), memo: 'Operating cash' },
        { account_id: repo.queryOne("SELECT id FROM account WHERE tenant_id=:t AND number='1500'").id, debit: Money.parse(640000), memo: 'Equipment & fit-out' },
        { account_id: repo.queryOne("SELECT id FROM account WHERE tenant_id=:t AND number='3010'").id, credit: Money.parse(500000), memo: 'Common stock' },
        { account_id: repo.queryOne("SELECT id FROM account WHERE tenant_id=:t AND number='3020'").id, credit: Money.parse(1500000), memo: 'Paid-in capital' },
        { account_id: acc.retained_earnings, credit: Money.parse(1040000), memo: 'Retained earnings brought forward' },
      ],
    });
  });

  // ================================================== procurement
  transaction(db, () => {
    // Initial stocking: every warehouse is filled before it ships anything,
    // so fulfilments always have a real average cost to relieve.
    const openingDate = addDays(monthsBack(7), 2);
    for (const loc of [locations.MAIN, locations.WEST, locations.UK]) {
      const byVendor = {};
      for (const it of stocked) {
        (byVendor[it.preferred_vendor_id] ||= []).push({
          item_id: it.id, quantity: loc === locations.UK ? between(30, 55) : between(80, 145),
          unit_price: Money.toNumber(it.purchase_price),
        });
      }
      for (const [vendorId, lines] of Object.entries(byVendor)) {
        const po = T.createTxn(repo, 'PURCHASE_ORDER', {
          entity_id: vendorId, txn_date: openingDate, location_id: loc,
          memo: 'Opening stock', lines,
        });
        const rcv = T.transform(repo, po.id, 'ITEM_RECEIPT', { txn_date: addDays(openingDate, 4) });
        const bill = T.transform(repo, rcv.id, 'VENDOR_BILL', { txn_date: addDays(openingDate, 6) });
        T.createPayment(repo, 'VENDOR_PAYMENT', { entity_id: vendorId, txn_date: addDays(openingDate, 30), amount: Money.toNumber(bill.total) });
      }
    }

    for (let m = 7; m >= 1; m--) {
      const poDate = addDays(monthsBack(m), between(1, 6));
      const vendorPool = vendors.filter((v) => ['Hardware', 'Components'].includes(v.category));
      for (const vendor of vendorPool) {
        const vendorItems = stocked.filter((i) => i.preferred_vendor_id === vendor.id);
        if (!vendorItems.length) continue;
        const lines = vendorItems.slice(0, between(2, 4)).map((it) => ({
          item_id: it.id, quantity: between(26, 60), unit_price: Money.toNumber(it.purchase_price),
        }));
        if (!lines.length) continue;
        const po = T.createTxn(repo, 'PURCHASE_ORDER', {
          entity_id: vendor.id, txn_date: poDate,
          location_id: pick([locations.MAIN, locations.WEST, locations.UK]),
          memo: 'Stock replenishment', lines,
        });
        const receipt = T.transform(repo, po.id, 'ITEM_RECEIPT', { txn_date: addDays(poDate, between(3, 12)) });
        const bill = T.transform(repo, receipt.id, 'VENDOR_BILL', { txn_date: addDays(poDate, between(4, 14)) });
        if (m > 1) T.createPayment(repo, 'VENDOR_PAYMENT', { entity_id: vendor.id, txn_date: addDays(bill.txn_date, between(10, 30)), amount: Money.toNumber(bill.total) });
      }
    }
  });

  // ================================================== operating costs
  transaction(db, () => {
    const opex = [
      ['Brightline Facilities', '6100', 18500, 'Office and warehouse rent'],
      ['Metro Power & Light', '6110', 3200, 'Utilities'],
      ['Vertex Cloud Services', '6300', 7400, 'Cloud and SaaS'],
      ['Ledgerworks Advisory', '6400', 5600, 'Accounting and advisory'],
      ['Sterling Office Supply', '6600', 1450, 'Office supplies'],
      ['Pacific Freight Partners', '5020', 6800, 'Inbound freight'],
    ];
    for (let m = 7; m >= 0; m--) {
      const d = addDays(monthsBack(m), 3);
      if (d > now) continue;
      for (const [vendorName, accountNumber, amount, memo] of opex) {
        const vendor = vendors.find((v) => v.name === vendorName);
        const account = repo.queryOne('SELECT id FROM account WHERE tenant_id = :t AND number = ?', [accountNumber]);
        const bill = T.createTxn(repo, 'VENDOR_BILL', {
          entity_id: vendor.id, txn_date: d, memo,
          lines: [{ account_id: account.id, description: memo, quantity: 1, unit_price: amount * (0.9 + R() * 0.25) }],
        });
        if (m > 0) T.createPayment(repo, 'VENDOR_PAYMENT', { entity_id: vendor.id, txn_date: addDays(d, between(12, 28)), amount: Money.toNumber(bill.total) });
      }
    }
  });

  // ================================================== order to cash
  transaction(db, () => {
    for (let m = 6; m >= 0; m--) {
      const ordersThisMonth = m === 0 ? between(8, 14) : between(52, 70);
      for (let k = 0; k < ordersThisMonth; k++) {
        const customer = pick(customers);
        // For the current month, only place orders on days that have happened.
        const elapsed = m === 0 ? Math.max(1, Number(now.slice(8, 10))) : 26;
        const orderDate = addDays(monthsBack(m), between(1, elapsed) - 1);
        if (orderDate > now) continue;
        const location = customer.subsidiary_id === ukSub ? locations.UK : (R() > 0.5 ? locations.MAIN : locations.WEST);

        const lineCount = between(1, 4);
        const lines = [];
        const used = new Set();
        for (let i = 0; i < lineCount; i++) {
          const it = R() > 0.25 ? pick(stocked) : pick(services);
          if (used.has(it.id)) continue;
          used.add(it.id);
          lines.push({ item_id: it.id, quantity: it.type === 'service' ? between(1, 4) : between(1, 12) });
        }
        if (!lines.length) continue;

        const so = T.createTxn(repo, 'SALES_ORDER', {
          entity_id: customer.id, txn_date: orderDate, location_id: location,
          memo: `Order for ${customer.name}`, sales_rep_id: customer.sales_rep_id,
          lines, override_credit: true,
        });
        if (so.status === 'pending_approval') T.approveTxn(repo, so.id);

        // Most orders ship and invoice; a slice stays open on purpose so the
        // fulfilment and billing queues are not empty.
        const roll = R();
        if (roll < 0.12) continue;
        // Never date a document in the future: clamp shipping and billing to
        // today so the current month shows real activity.
        const earliest = (a, b) => (a > b ? b : a);
        const shipDate = earliest(addDays(orderDate, between(1, 8)), now);
        if (shipDate < orderDate) continue;
        try { T.transform(repo, so.id, 'FULFILLMENT', { txn_date: shipDate, tracking_no: `1Z${between(100000, 999999)}${between(1000, 9999)}` }); }
        catch { /* service-only orders have nothing to ship */ }

        if (roll < 0.2) continue;
        const invoiceDate = earliest(addDays(shipDate, between(0, 3)), now);
        let invoice;
        try { invoice = T.transform(repo, so.id, 'INVOICE', { txn_date: invoiceDate }); }
        catch { continue; }

        // Collections behave like a real ledger: the older an invoice is, the
        // more likely it has been settled. That leaves a believable aging
        // profile -- mostly current, with a genuine but small overdue tail --
        // instead of every historic invoice sitting unpaid.
        const ageDays = Math.max(0, Math.round((Date.parse(now) - Date.parse(invoice.txn_date)) / 86400000));
        const payFull = ageDays > 75 ? 0.975 : ageDays > 45 ? 0.94 : ageDays > 25 ? 0.8 : 0.45;
        const payPart = payFull + (ageDays > 25 ? 0.06 : 0.14);
        const payRoll = R();
        if (payRoll < payFull) {
          const settleIn = Math.min(ageDays, between(8, 44));
          T.createPayment(repo, 'CUSTOMER_PAYMENT', {
            entity_id: customer.id, txn_date: addDays(invoice.txn_date, settleIn) > now ? now : addDays(invoice.txn_date, settleIn),
            amount: Money.toNumber(invoice.total),
            applications: [{ txn_id: invoice.id, amount: Money.toNumber(invoice.total) }],
          });
        } else if (payRoll < payPart) {
          const part = Math.round(Money.toNumber(invoice.total) * (0.3 + R() * 0.4));
          T.createPayment(repo, 'CUSTOMER_PAYMENT', {
            entity_id: customer.id, txn_date: addDays(invoice.txn_date, Math.min(ageDays, between(10, 30))),
            amount: part, applications: [{ txn_id: invoice.id, amount: part }],
          });
        }
      }
    }
  });

  // ================================================== pipeline
  transaction(db, () => {
    const leadNames = [
      ['Priya Anand', 'Crestline Analytics'], ['Diego Moreno', 'Fairview Transit'],
      ['Hannah Weiss', 'Oakfield Diagnostics'], ['Kwame Mensah', 'Riverbend Utilities'],
      ['Ines Duarte', 'Solstice Robotics'], ['Nils Haugen', 'Trellis Agritech'],
      ['Amelia Croft', 'Wharfside Brewing'], ['Rustam Aliyev', 'Highgate Chambers'],
      ['Bex Okoro', 'Nimbus Data Centres'], ['Carla Rossi', 'Pallas Museums Trust'],
      ['Ted Kowalski', 'Beaumont Machining'], ['Sana Iqbal', 'Verdant Landscaping'],
    ];
    for (const [name, company] of leadNames) {
      crm.createLead(repo, {
        name, company, email: `${name.split(' ')[0].toLowerCase()}@${company.toLowerCase().replace(/[^a-z]/g, '').slice(0, 14)}.test`,
        phone: `+1 ${between(200, 799)} 555 ${between(1000, 9999)}`,
        title: pick(['IT Manager', 'CTO', 'Facilities Director', 'Procurement Lead']),
        source: pick(['web', 'referral', 'event', 'outbound', 'partner']),
        status: pick(['new', 'new', 'working', 'working', 'qualified']),
        rating: pick(['hot', 'warm', 'warm', 'cold']),
        score: between(10, 95), industry: pick(['Technology', 'Manufacturing', 'Healthcare', 'Public Sector']),
        estimated_value: between(15, 240) * 1000,
        owner_id: provisioned.ownerId,
      });
    }

    const dealNames = ['network refresh', 'campus wifi rollout', 'firewall upgrade', 'DC consolidation',
      'branch expansion', 'security hardening', 'edge deployment', 'core switch replacement',
      'annual support renewal', 'redundancy project', 'fibre backbone', 'site survey and build'];
    for (let i = 0; i < 34; i++) {
      const customer = pick(customers);
      const stage = pick(['prospecting', 'prospecting', 'qualification', 'qualification', 'proposal', 'proposal', 'negotiation', 'closed_won', 'closed_lost']);
      const created = addDays(now, -between(10, 210));
      const opp = crm.createOpportunity(repo, {
        name: `${customer.name} — ${pick(dealNames)}`,
        customer_id: customer.id, stage,
        amount: between(12, 320) * 1000, currency: customer.currency,
        expected_close: addDays(now, stage.startsWith('closed') ? -between(1, 60) : between(-10, 120)),
        owner_id: provisioned.ownerId, sales_rep_id: customer.sales_rep_id,
        subsidiary_id: customer.subsidiary_id,
        source: pick(['web', 'referral', 'event', 'outbound', 'partner']),
        next_step: pick(['Send revised quote', 'Schedule technical review', 'Confirm budget holder', 'Awaiting PO', 'Follow up after demo']),
      });
      repo.update('opportunity', opp.id, { created_at: created + 'T09:00:00Z' });
      if (stage === 'closed_lost') crm.updateOpportunity(repo, opp.id, { stage: 'closed_lost', lost_reason: pick(['Price', 'Incumbent renewed', 'Project deferred', 'Lost to competitor']) });
    }

    for (let i = 0; i < 26; i++) {
      crm.createActivity(repo, {
        type: pick(['task', 'call', 'meeting', 'email']),
        subject: pick(['Quarterly business review', 'Follow up on quote', 'Technical discovery call',
          'Renewal conversation', 'Escalation check-in', 'Send updated pricing', 'Site visit']),
        related_type: 'customer', related_id: pick(customers).id,
        due_date: addDays(now, between(-12, 21)),
        priority: pick(['low', 'normal', 'normal', 'high']),
        assigned_to: provisioned.ownerId,
      });
    }
  });

  // ================================================== support
  transaction(db, () => {
    const subjects = [
      'Router dropping connections after firmware update', 'Switch port not negotiating 10G',
      'RMA request for damaged access point', 'Firewall licence renewal question',
      'Slow throughput on fibre link', 'Need replacement power supply',
      'Configuration backup failing', 'Warranty status enquiry',
      'PoE budget exceeded on 48-port switch', 'Request for on-site engineer',
      'Invoice query — duplicate line', 'SFP module not recognised',
      'Rack delivery scheduling', 'VLAN tagging misconfiguration',
      'Support contract coverage question', 'Firmware rollback guidance',
    ];
    subjects.forEach((subject, i) => {
      const c = crm.createCase(repo, {
        subject, customer_id: pick(customers).id,
        description: `${subject}. Reported by the customer's IT team; awaiting triage.`,
        priority: pick(['low', 'medium', 'medium', 'high', 'urgent']),
        category: pick(['hardware', 'software', 'billing', 'general', 'rma']),
        origin: pick(['email', 'phone', 'portal']),
        assigned_to: i % 3 === 0 ? null : provisioned.ownerId,
      });
      repo.update('support_case', c.id, { created_at: addDays(now, -between(0, 45)) + 'T10:00:00Z' });
      if (i % 3 === 1) {
        crm.addCaseMessage(repo, c.id, { body: 'Thanks for reaching out — we are reproducing this in the lab and will update you today.', authorType: 'agent' });
      }
      if (i % 4 === 0) {
        crm.updateCase(repo, c.id, { status: 'resolved', resolution: 'Firmware 4.2.1 shipped and verified with the customer.' });
      }
    });
  });

  // ================================================== time & payroll
  transaction(db, () => {
    const timeEmployees = [employees['Owen Brady'], employees['Theo Alvarez'], employees['Freya Nilsen'], employees['Samuel Adeyemi']];
    for (const empId of timeEmployees) {
      for (let d = 25; d >= 0; d--) {
        const date = addDays(now, -d);
        if ([0, 6].includes(new Date(date + 'T00:00:00Z').getUTCDay())) continue;
        hr.logTime(repo, {
          employee_id: empId, entry_date: date, hours: between(6, 9),
          customer_id: R() > 0.5 ? pick(customers).id : null,
          billable: R() > 0.5, project: pick(['Install', 'Support', 'Internal', 'Deployment']),
          status: d > 7 ? 'approved' : 'submitted',
          memo: pick(['On-site installation', 'Remote support', 'Configuration work', 'Customer escalation']),
        });
      }
    }
    hr.requestTimeOff(repo, { employee_id: employees['Sofia Marchetti'], type: 'vacation', start_date: addDays(now, 14), end_date: addDays(now, 21), note: 'Family holiday' });
    hr.requestTimeOff(repo, { employee_id: employees['Jonah Petrov'], type: 'sick', start_date: addDays(now, -3), end_date: addDays(now, -2), note: 'Flu' });

    // A payroll run for every completed month of the demo history, so the
    // income statement carries a realistic, evenly spread cost base.
    for (let m = 7; m >= 1; m--) {
      const start = startOfMonth(addMonths(now, -m));
      const end = addDays(startOfMonth(addMonths(now, -(m - 1))), -1);
      if (end >= now) continue;
      const run = hr.calculatePayroll(repo, { period_start: start, period_end: end, pay_date: end, subsidiary_id: usSub });
      hr.approvePayroll(repo, run.id);
    }
  });

  // ================================================== platform config
  transaction(db, () => {
    // --- approval rules
    repo.insert('approval_rule', {
      id: ulid(), name: 'Sales orders over $50,000', txn_type: 'SALES_ORDER',
      condition: 'total > 50000', approver_role_id: provisioned.roleIds['Sales Manager'],
      sequence: 1, active: 1, created_at: nowIso(),
    });
    repo.insert('approval_rule', {
      id: ulid(), name: 'Line discount above 20%', txn_type: 'SALES_ORDER',
      condition: 'max_line_discount > 20', approver_role_id: provisioned.roleIds['Sales Manager'],
      sequence: 2, active: 1, created_at: nowIso(),
    });
    repo.insert('approval_rule', {
      id: ulid(), name: 'Purchase orders over $25,000', txn_type: 'PURCHASE_ORDER',
      condition: 'total > 25000', approver_role_id: provisioned.roleIds.Controller,
      sequence: 1, active: 1, created_at: nowIso(),
    });

    // --- pricing rules
    repo.insert('pricing_rule', {
      id: ulid(), name: 'Volume break: 25+ units', priority: 10,
      condition: 'quantity >= 25', action: 'discount_pct', value: 12, stackable: 0,
      active: 1, created_at: nowIso(),
    });
    repo.insert('pricing_rule', {
      id: ulid(), name: 'Volume break: 10+ units', priority: 20,
      condition: 'quantity >= 10', action: 'discount_pct', value: 7, stackable: 0,
      active: 1, created_at: nowIso(),
    });
    repo.insert('pricing_rule', {
      id: ulid(), name: 'Education sector discount', priority: 30,
      condition: 'customer.category == "Education"', action: 'discount_pct', value: 15, stackable: 0,
      active: 1, created_at: nowIso(),
    });

    // --- custom fields
    platform.createCustomField(repo, {
      record_type: 'customer', name: 'account_tier', label: 'Account tier', type: 'select',
      options: ['Strategic', 'Enterprise', 'Mid-market', 'SMB'], display_order: 1, show_in_list: 1,
      help_text: 'Drives service levels and QBR cadence.',
    });
    platform.createCustomField(repo, {
      record_type: 'customer', name: 'renewal_date', label: 'Support renewal date', type: 'date', display_order: 2,
    });
    platform.createCustomField(repo, {
      record_type: 'opportunity', name: 'competitor_present', label: 'Competitor in the deal', type: 'checkbox', display_order: 1,
    });
    platform.createCustomField(repo, {
      record_type: 'opportunity', name: 'deal_health', label: 'Deal health', type: 'formula',
      formula: 'IF(probability >= 70, "Strong", IF(probability >= 40, "Watch", "At risk"))',
      display_order: 2, show_in_list: 1,
    });
    platform.createCustomField(repo, {
      record_type: 'item', name: 'warranty_months', label: 'Warranty (months)', type: 'number', display_order: 1,
    });

    // --- workflows
    platform.createWorkflow(repo, {
      name: 'Flag high-value invoices for the controller',
      description: 'Any invoice over $50,000 raises a notification and a review task.',
      record_type: 'invoice', trigger: 'after_create', condition: 'total > 50000',
      status: 'released', priority: 10,
      actions: [
        { type: 'notify', title: '=CONCAT("High-value invoice ", txn_no)', body: '=CONCAT("Invoice for ", TEXT(total), " needs a second look.")', severity: 'warning' },
        { type: 'create_task', subject: '=CONCAT("Review invoice ", txn_no)', due_in_days: 2 },
      ],
    });
    platform.createWorkflow(repo, {
      name: 'Escalate urgent support cases',
      description: 'Urgent cases create a same-day follow-up task.',
      record_type: 'support_case', trigger: 'after_create', condition: 'priority == "urgent"',
      status: 'released', priority: 20,
      actions: [
        { type: 'create_task', subject: '=CONCAT("URGENT: ", subject)', due_in_days: 1, priority: 'high' },
        { type: 'notify', title: 'Urgent case raised', body: '=subject', severity: 'error' },
      ],
    });
    platform.createWorkflow(repo, {
      name: 'Require a close date on late-stage deals',
      description: 'Blocks saving a proposal or negotiation deal with no expected close date.',
      record_type: 'opportunity', trigger: 'before_update',
      condition: 'stage in ["proposal","negotiation"] && ISBLANK(expected_close)',
      status: 'released', priority: 5,
      actions: [{ type: 'block', message: 'Deals at proposal or later need an expected close date.' }],
    });

    // --- saved searches
    platform.saveSearch(repo, {
      name: 'Overdue invoices', record_type: 'invoice',
      definition: {
        columns: ['txn_no', 'txn_date', 'entity_id', 'due_date', 'total', 'amount_remaining', 'status'],
        filters: [{ field: 'amount_remaining', op: 'gt', value: 0 }, { field: 'due_date', op: 'lt', value: today() }],
        sort: 'due_date ASC',
      },
    });
    platform.saveSearch(repo, {
      name: 'Open sales orders awaiting shipment', record_type: 'sales_order',
      definition: {
        columns: ['txn_no', 'txn_date', 'entity_id', 'status', 'total', 'location_id'],
        filters: [{ field: 'status', op: 'in', value: ['open', 'partially_fulfilled'] }],
        sort: 'txn_date ASC',
      },
    });
    platform.saveSearch(repo, {
      name: 'Deals closing this quarter', record_type: 'opportunity',
      definition: {
        columns: ['opp_no', 'name', 'customer_id', 'stage', 'amount', 'probability', 'expected_close'],
        filters: [{ field: 'expected_close', op: 'between', value: [today(), addDays(today(), 90)] }],
        sort: 'expected_close ASC', group: 'stage',
        aggregate: [{ fn: 'sum', field: 'amount' }],
      },
    });
    platform.saveSearch(repo, {
      name: 'Unassigned support cases', record_type: 'support_case',
      definition: {
        columns: ['case_no', 'subject', 'customer_id', 'priority', 'status', 'created_at'],
        filters: [{ field: 'assigned_to', op: 'empty' }, { field: 'status', op: 'in', value: ['new', 'open', 'pending'] }],
        sort: 'created_at ASC',
      },
    });

    // --- default dashboard
    repo.insert('dashboard', {
      id: ulid(), user_id: null, name: 'Home', updated_at: nowIso(),
      layout: ['cash_balance', 'revenue_mtd', 'gross_margin', 'ar_overdue', 'open_orders', 'pipeline',
        'revenue_trend', 'ar_aging', 'top_customers', 'approvals', 'reorder', 'cases'],
    });
  });

  // ================================================== operations
  // Projects, a build, a pick wave and a day of field service, so the
  // operational screens open on something real rather than an empty state.
  transaction(db, () => {
    const usSubId = repo.queryOne('SELECT id FROM subsidiary WHERE tenant_id = :t AND parent_id IS NULL').id;

    // --- professional services engagements
    const engagements = [
      ['Halcyon Health Systems', 'Campus network refresh', 'time_and_materials', 240000, 0.62],
      ['Blue Harbor Financial', 'Branch Wi-Fi rollout', 'fixed_price', 185000, 0.85],
      ['Ironbridge Energy', 'SCADA segmentation review', 'time_and_materials', 96000, 0.30],
      ['Northstar Biotech', 'Lab network build-out', 'milestone', 310000, 0.15],
    ];
    const consultants = ['Elena Vasquez', 'Rafael Ortiz', 'Nadia Haddad', 'Owen Fitzgerald']
      .map((n) => employees[n]).filter(Boolean);
    const fallbackStaff = Object.values(employees);

    engagements.forEach(([customerName, name, billing, budget, progress], engIndex) => {
      const customer = customers.find((c) => c.name === customerName);
      const project = projects.createProject(repo, {
        name,
        customer_id: customer?.id || null,
        subsidiary_id: usSubId,
        manager_id: employees['Tomas Bergstrom'] || null,
        billing_type: billing,
        fixed_fee: billing === 'fixed_price' ? budget : 0,
        budget_amount: budget,
        start_date: addDays(now, -Math.round(120 * progress) - 40),
        end_date: addDays(now, 90),
        status: 'active',
      });

      // Tasks. Progress is derived from the time booked against them, never
      // set directly, so the tasks are created here and the hours below are
      // what actually move the percentage.
      const taskNames = ['Discovery & survey', 'Design', 'Procurement', 'Installation', 'Handover'];
      const tasks = taskNames.map((t, i) => projects.addTask(repo, project.id, {
        name: t, sequence: i + 1,
        estimated_hours: 40 + i * 20,
        start_date: addDays(now, -60 + i * 12),
        end_date: addDays(now, -50 + i * 12),
        // The tasks the engagement has already passed are done.
        status: (i + 1) / taskNames.length <= progress ? 'complete' : i / taskNames.length < progress ? 'in_progress' : 'not_started',
      }));

      // Someone has to be booked on it, or the utilisation table is empty --
      // but rotate through the roster, or the first two people end up on all
      // four engagements and the screen shows everyone at 200%.
      const bench = consultants.length ? consultants : fallbackStaff;
      for (let k = 0; k < 2; k++) {
        const staff = bench[(engIndex * 2 + k) % bench.length];
        if (!staff) continue;
        projects.allocate(repo, {
          project_id: project.id, employee_id: staff,
          start_date: addDays(now, -30), end_date: addDays(now, 60),
          hours_per_week: 12 + Math.round(R() * 8),
        });
      }

      // Billable time, some of it not yet invoiced. Each engagement gets its
      // own consultant and its own days: one person cannot bill four projects
      // eight hours each on the same date, and the time module rightly refuses.
      const worker = (consultants.length ? consultants : fallbackStaff)[engIndex % (consultants.length || fallbackStaff.length)];
      const workedTasks = tasks.filter((t) => t.status !== 'not_started');
      const timeIds = [];
      for (let d = 1; d <= 12; d++) {
        if (R() < 0.3) continue;
        const task = workedTasks[d % (workedTasks.length || 1)] || tasks[0];
        const entry = hr.logTime(repo, {
          employee_id: worker,
          entry_date: addDays(now, -(d * 4 + engIndex)),
          hours: 4 + Math.round(R() * 4),
          project_id: project.id,
          task_id: task?.id || null,
          billable: 1,
          bill_rate: 185,
          cost_rate: 92,
          memo: `${name}: on-site work`,
        });
        timeIds.push(entry.id);
      }
      // Only approved time counts towards cost and progress, which is the
      // point of the approval step -- so approve most of it and leave a
      // little in draft, the way a real week looks.
      if (timeIds.length) hr.approveTime(repo, timeIds.slice(0, Math.ceil(timeIds.length * 0.8)));
      projects.recalcProgress(repo, project.id);
    });

    // --- a build: bill of material, work order, components issued
    const assembly = repo.queryOne("SELECT * FROM item WHERE tenant_id = :t AND type = 'assembly' LIMIT 1")
      || repo.queryOne("SELECT * FROM item WHERE tenant_id = :t AND type = 'inventory' ORDER BY sku LIMIT 1");
    const components = repo.query(
      "SELECT * FROM item WHERE tenant_id = :t AND type = 'inventory' AND id != ? ORDER BY sku LIMIT 3", [assembly.id]);
    if (components.length >= 2) {
      // Real work centres, so routing carries a labour and overhead rate and
      // a job accumulates cost the way it would on a shop floor.
      const workCentres = [
        ['Bench 1', 3200, 1400], ['Test', 4100, 1800],
      ].map(([name, labour, overhead]) => repo.insert('work_center', {
        id: ulid(), name, location_id: locations.MAIN,
        capacity_hours_per_day: Qty.parse(8),
        labour_rate: labour, overhead_rate: overhead,
        labour_account_id: acc.labour_absorbed, overhead_account_id: acc.overhead_absorbed,
        active: 1, created_at: nowIso(),
      }));

      const bom = manufacturing.createBom(repo, {
        item_id: assembly.id, name: `${assembly.name} — standard build`, revision: 'A', is_default: 1,
        lines: components.map((c, i) => ({ component_id: c.id, quantity: i + 1, scrap_pct: i === 0 ? 2 : 0 })),
        routing: [
          { operation_no: 10, name: 'Assemble chassis', work_center_id: workCentres[0], setup_hours: 0.5, run_hours: 1.2 },
          { operation_no: 20, name: 'Burn-in and test', work_center_id: workCentres[1], setup_hours: 0.2, run_hours: 0.8 },
        ],
      });
      manufacturing.releaseBom(repo, bom.id);

      // One order part-way through, one still planned, so the board has range.
      const wo = manufacturing.createWorkOrder(repo, {
        item_id: assembly.id, bom_id: bom.id, quantity: 25,
        location_id: locations.MAIN, subsidiary_id: usSubId,
        start_date: addDays(now, -6), due_date: addDays(now, 8),
      });
      manufacturing.releaseWorkOrder(repo, wo.id);
      try {
        manufacturing.issueComponents(repo, wo.id, { txn_date: addDays(now, -5) });
        // Labour booked against the first operation, then part of the run
        // received into stock: the job is genuinely mid-flight.
        const ops = manufacturing.woOperations(repo, wo.id);
        if (ops[0]) manufacturing.logOperation(repo, wo.id, ops[0].id, { hours: 14, complete: true });
        if (ops[1]) manufacturing.logOperation(repo, wo.id, ops[1].id, { hours: 6 });
        manufacturing.buildWorkOrder(repo, wo.id, { quantity: 15, txn_date: addDays(now, -2) });
      } catch { /* not enough stock in the demo books: leave it released */ }

      // And one finished job, so the variance and cost-roll screens have a
      // completed example to show rather than only work in progress.
      try {
        const done = manufacturing.createWorkOrder(repo, {
          item_id: assembly.id, bom_id: bom.id, quantity: 5,
          location_id: locations.MAIN, subsidiary_id: usSubId,
          start_date: addDays(now, -30), due_date: addDays(now, -22),
        });
        manufacturing.releaseWorkOrder(repo, done.id);
        manufacturing.issueComponents(repo, done.id, { txn_date: addDays(now, -29) });
        for (const op of manufacturing.woOperations(repo, done.id)) {
          manufacturing.logOperation(repo, done.id, op.id, { hours: 3, complete: true });
        }
        manufacturing.buildWorkOrder(repo, done.id, { txn_date: addDays(now, -24), close: true });
      } catch { /* same */ }

      manufacturing.createWorkOrder(repo, {
        item_id: assembly.id, bom_id: bom.id, quantity: 40,
        location_id: locations.MAIN, subsidiary_id: usSubId,
        start_date: addDays(now, 3), due_date: addDays(now, 21),
      });

      manufacturing.recordInspection(repo, {
        reference_type: 'work_order', reference_id: wo.id,
        item_id: assembly.id, inspected_at: `${addDays(now, -4)}T14:00:00.000Z`,
        quantity_inspected: 25, quantity_passed: 24, quantity_failed: 1,
        inspector_id: employees['Tomas Bergstrom'] || null,
        notes: 'One unit failed burn-in; returned to the bench.',
      });
    }

    // --- warehouse: bins at the main site, and a wave over open orders
    const binCodes = [['A-01-01', 'picking'], ['A-01-02', 'picking'], ['B-02-01', 'storage'],
      ['STAGE-1', 'staging'], ['RECV', 'receiving']];
    binCodes.forEach(([code, binType], i) => {
      warehouse.createBin(repo, { location_id: locations.MAIN, code, bin_type: binType, pick_sequence: i + 1 });
    });
    const openOrders = repo.query(
      `SELECT id FROM txn WHERE tenant_id = :t AND type = 'SALES_ORDER' AND status = 'open' LIMIT 6`);
    if (openOrders.length) {
      try {
        warehouse.createWave(repo, {
          location_id: locations.MAIN, txn_ids: openOrders.map((o) => o.id), strategy: 'batch',
        });
      } catch { /* nothing allocatable in the demo books */ }
    }

    // --- field service: technicians, contracts and a day of jobs
    // `technician` rows describe a person's skills and rate; the schedulable
    // identity on a service order is the employee they belong to.
    const techStaff = Object.entries(employees).slice(0, 3);
    const technicianEmployeeIds = techStaff.map(([, id]) => id);
    techStaff.forEach(([, id], i) => repo.insert('technician', {
      id: ulid(), employee_id: id,
      skills: [['networking', 'wireless'], ['electrical', 'networking'], ['wireless']][i] || ['networking'],
      hourly_rate: Money.parse([95, 88, 102][i] || 90),
      home_location_id: locations.MAIN, van_location_id: null,
      service_radius_km: 60, active: 1, created_at: nowIso(),
    }));

    const serviceCustomers = customers.slice(0, 4);
    serviceCustomers.forEach((c, i) => {
      const contract = repo.insert('service_contract', {
        id: ulid(), contract_no: `SVC-C${String(i + 1).padStart(4, '0')}`,
        customer_id: c.id, name: ['Gold cover', 'Silver cover', 'Gold cover', 'Bronze cover'][i],
        start_date: addDays(now, -300),
        // Two of them lapse inside the renewal window, which is the point of
        // that table: it should never be empty when something needs chasing.
        end_date: addDays(now, [25, 70, 240, 55][i]),
        billing_frequency: 'annual', amount: Money.parse([24000, 12000, 30000, 6000][i]),
        coverage: ['24x7', 'business_hours', '24x7', 'business_hours'][i],
        visits_included: [12, 6, 16, 2][i], visits_used: [9, 2, 4, 2][i],
        response_hours: [4, 8, 4, 24][i], status: 'active', created_at: nowIso(),
      });

      const asset = repo.insert('service_asset', {
        id: ulid(), asset_tag: `AST-${String(i + 1).padStart(4, '0')}`,
        name: `${c.name} core switch`, customer_id: c.id,
        item_id: stocked[i % stocked.length]?.id || null,
        serial_no: `SN${100000 + i}`, installed_at: addDays(now, -420),
        warranty_end: addDays(now, 120), contract_id: contract,
        site_address: c.billing_address || {}, status: 'active',
        meter_reading: 0, notes: '', created_at: nowIso(),
      });

      const order = service.createOrder(repo, {
        customer_id: c.id, subsidiary_id: usSubId, asset_id: asset, contract_id: contract,
        location_id: locations.MAIN,
        order_type: ['maintenance', 'repair', 'install', 'inspection'][i],
        priority: i === 1 ? 'emergency' : i === 3 ? 'low' : 'normal',
        requested_date: today(),
        description: ['Quarterly preventative visit', 'Switch dropping packets under load',
          'Install second access point', 'Annual safety inspection'][i],
      });
      // Three of the four go out today; one is left for the dispatcher to place.
      if (i < 3 && technicianEmployeeIds[i % technicianEmployeeIds.length]) {
        service.schedule(repo, order.id, {
          technician_id: technicianEmployeeIds[i % technicianEmployeeIds.length],
          scheduled_start: `${today()}T${String(8 + i * 3).padStart(2, '0')}:00:00.000Z`,
          scheduled_end: `${today()}T${String(10 + i * 3).padStart(2, '0')}:00:00.000Z`,
        });
      }
    });
  });

  // ================================================== finance & people
  // The modules a first look most often finds empty: capital assets on the
  // books, a budget to measure against, expenses waiting for a decision,
  // marketing spend to attribute, an online channel, and a review round.
  transaction(db, () => {
    const usSubId = repo.queryOne('SELECT id FROM subsidiary WHERE tenant_id = :t AND parent_id IS NULL').id;
    const num = (n) => repo.queryOne('SELECT id FROM account WHERE tenant_id = :t AND number = ?', [n])?.id;

    // --- fixed assets: two classes, a register, and depreciation caught up
    const classes = [
      ['Computer Equipment', 36, 5],
      ['Office Fit-out', 84, 0],
    ].map(([name, life, salvage]) => repo.insert('asset_class', {
      id: ulid(), name, method: 'STRAIGHT_LINE', life_months: life,
      salvage_pct: salvage, declining_rate: 2.0,
      asset_account_id: num('1500'), accum_account_id: num('1590'),
      expense_account_id: num('6800'), disposal_account_id: num('7050'),
      active: 1, created_at: nowIso(),
    }));

    // Acquisition dates stay inside the fiscal year the books cover: an asset
    // bought before the first period has depreciation with nowhere to post,
    // which is a real situation but not one a demo should open on.
    const firstPeriod = repo.queryOne(
      'SELECT start_date FROM accounting_period WHERE tenant_id = :t ORDER BY start_date LIMIT 1')?.start_date;
    const register = [
      ['Engineering laptop fleet (12)', 0, 54000, 7],
      ['Warehouse barcode scanners', 0, 8600, 5],
      ['Lab test rig', 0, 31500, 6],
      ['Server room UPS', 0, 12400, 3],
      ['Office fit-out — Portland', 1, 96000, 8],
      ['Meeting room AV', 1, 18700, 2],
    ];
    for (const [name, cls, cost, monthsAgo] of register) {
      let acquired = startOfMonth(addMonths(now, -monthsAgo));
      if (firstPeriod && acquired < firstPeriod) acquired = firstPeriod;
      const a = assets.createAsset(repo, {
        name, class_id: classes[cls], subsidiary_id: usSubId,
        location_id: locations.MAIN, acquisition_date: acquired, cost,
      });
      assets.placeInService(repo, a.id, { in_service_date: acquired });
    }
    // Post everything due up to the end of last month, so the register shows
    // real accumulated depreciation and this month is still to run.
    assets.runDepreciation(repo, { through: addDays(startOfMonth(now), -1) });

    // --- a budget for the current year, built from what actually happened
    const fiscalYear = Number(now.slice(0, 4));
    const plan = budget.createBudget(repo, {
      name: `Operating budget ${fiscalYear}`, scenario: 'budget',
      fiscal_year: fiscalYear, subsidiary_id: usSubId,
      currency: provisioned.tenant.base_currency || 'USD',
      notes: 'Built from last year uplifted 8%, then adjusted by department.',
    });
    // Budget every month of the year against what actually happened, with a
    // deterministic wobble, so budget-versus-actual shows a real spread of
    // favourable and unfavourable rather than one flat percentage.
    const yearPeriods = repo.query(
      'SELECT id FROM accounting_period WHERE tenant_id = :t AND fiscal_year = ? ORDER BY start_date', [fiscalYear]);
    const pnl = repo.query(`SELECT a.id, a.type,
        COALESCE(SUM(ABS(b.base_debit - b.base_credit)), 0) AS activity
      FROM account a LEFT JOIN gl_balance b ON b.tenant_id = a.tenant_id AND b.account_id = a.id
      WHERE a.tenant_id = :t AND a.is_summary = 0 AND a.type IN ('INCOME','EXPENSE')
      GROUP BY a.id HAVING activity > 0`);
    const budgetLines = [];
    for (const account of pnl) {
      const perMonth = account.activity / Math.max(1, yearPeriods.length);
      for (const period of yearPeriods) {
        const wobble = 0.88 + R() * 0.27;           // -12% .. +15%
        budgetLines.push({
          account_id: account.id, period_id: period.id,
          amount: Money.toNumber(Math.round(perMonth * wobble)),
        });
      }
    }
    if (budgetLines.length) budget.setLines(repo, plan.id, budgetLines);
    budget.setStatus(repo, plan.id, 'approved');

    // --- expense reports at each stage of approval
    const claimants = ['Yuki Tanaka', 'Chidi Okonkwo', 'Freya Nilsen', 'Owen Brady']
      .map((n) => employees[n]).filter(Boolean);
    const claims = [
      [['Client dinner — Halcyon', 'meals', 184.5], ['Taxi to site', 'travel', 42], ['Hotel, two nights', 'travel', 318]],
      [['Flights to Chicago', 'travel', 428], ['Conference pass', 'training', 995]],
      [['Replacement laptop charger', 'equipment', 79.99], ['Parking', 'travel', 24]],
      [['Team lunch', 'meals', 112.4]],
    ];
    claimants.forEach((employeeId, i) => {
      if (!claims[i]) return;
      const report = projects.createExpenseReport(repo, {
        employee_id: employeeId, subsidiary_id: usSubId,
        report_date: addDays(now, -(6 + i * 5)),
        memo: ['Halcyon kickoff visit', 'NetCon 2026', 'Sundries', 'Sprint close'][i],
        lines: claims[i].map(([description, category, amount], j) => ({
          expense_date: addDays(now, -(8 + i * 5 + j)),
          category, description, amount, billable: i === 0 ? 1 : 0,
          account_id: category === 'travel' ? num('6500') : category === 'training' ? num('6400') : num('6500'),
        })),
      });
      // One paid, one approved and awaiting payment, one submitted and
      // waiting on a decision, one still being written up.
      if (i <= 2) projects.submitExpenseReport(repo, report.id);
      if (i <= 1) projects.decideExpenseReport(repo, report.id, { approve: true });
      if (i === 0) projects.reimburseExpenseReport(repo, report.id, { paid_date: addDays(now, -2) });
    });

    // --- marketing: campaigns with spend, and reseller partners on commission
    const campaigns = [
      ['Spring datacentre refresh', 'email', 18000, 16240, -120, -30],
      ['NetCon 2026 sponsorship', 'event', 42000, 41500, -75, -40],
      ['Search — switching', 'paid_search', 24000, 19880, -180, 0],
      ['Partner co-marketing Q3', 'partner', 15000, 4200, -20, 45],
    ].map(([name, channel, plannedSpend, spent, from, to]) => commerce.createCampaign(repo, {
      name, channel, status: to > 0 ? 'active' : 'complete',
      start_date: addDays(now, from), end_date: addDays(now, to),
      budget: plannedSpend, actual_cost: spent,
      target_audience: 'Mid-market IT and facilities',
      owner_id: employees['Sofia Marchetti'] || null,
    }));
    // Attribute the existing pipeline across them so the ROI figures mean
    // something rather than dividing by an empty set.
    const opps = repo.query('SELECT id FROM opportunity WHERE tenant_id = :t ORDER BY created_at LIMIT 24');
    opps.forEach((o, i) => repo.update('opportunity', o.id, { campaign_id: campaigns[i % campaigns.length].id }));
    const leads = repo.query('SELECT id FROM lead WHERE tenant_id = :t ORDER BY created_at LIMIT 30');
    leads.forEach((l, i) => repo.update('lead', l.id, { campaign_id: campaigns[i % campaigns.length].id }));
    for (const c of campaigns) commerce.recalcCampaign(repo, c.id);

    const partners = [
      ['Northwind Integrators', 'reseller', 'gold', 12],
      ['Cobalt Managed Services', 'msp', 'silver', 8],
      ['Aldgate Systems', 'referral', 'standard', 5],
    ].map(([name, partner_type, tier, pct]) => commerce.createPartner(repo, {
      name, partner_type, tier, commission_pct: pct,
      email: `partners@${name.split(' ')[0].toLowerCase()}.example`,
      manager_id: employees['Sofia Marchetti'] || null,
    }));
    // A slice of recent invoices came through partners, and each accrues.
    const partnerInvoices = repo.query(
      "SELECT id FROM txn WHERE tenant_id = :t AND type = 'INVOICE' AND status != 'voided' ORDER BY txn_date DESC LIMIT 9");
    partnerInvoices.forEach((t, i) => {
      repo.update('txn', t.id, { partner_id: partners[i % partners.length].id });
      try { commerce.accrueCommission(repo, t.id); } catch { /* nothing to accrue */ }
    });

    // --- an online channel with listings and a few live carts
    const channel = commerce.createChannel(repo, {
      name: 'Web store', channel_type: 'web', subsidiary_id: usSubId,
      currency: provisioned.tenant.base_currency || 'USD', location_id: locations.MAIN,
    });
    const sellable = repo.query("SELECT id, name, base_price FROM item WHERE tenant_id = :t AND active = 1 ORDER BY sku LIMIT 12");
    commerce.publishListings(repo, channel.id, sellable.map((i) => i.id));

    const shoppers = repo.query('SELECT id, name, email FROM customer WHERE tenant_id = :t ORDER BY created_at LIMIT 5');
    shoppers.forEach((c, i) => {
      const picked = sellable.slice(i, i + 2);
      if (!picked.length) return;
      const cartLines = picked.map((it) => ({
        item_id: it.id, name: it.name, quantity: (i % 3) + 1,
        unit_price: Money.toNumber(it.base_price),
      }));
      repo.insert('cart', {
        id: ulid(), channel_id: channel.id, customer_id: c.id, email: c.email || '',
        // Most carts are abandoned; that is the number the screen exists for.
        status: i === 0 ? 'open' : i === 1 ? 'open' : 'abandoned',
        currency: provisioned.tenant.base_currency || 'USD',
        subtotal: Money.parse(cartLines.reduce((t2, l) => t2 + l.unit_price * l.quantity, 0)),
        lines: cartLines, converted_txn_id: null,
        created_at: addDays(now, -(2 + i)), updated_at: addDays(now, -(1 + i)),
      });
    });

    // --- deferred revenue and a prepayment, both part way through
    // A support plan sold in advance and a year of insurance paid up front:
    // the two shapes that make cash and the profit and loss disagree.
    const supportPlan = schedules.createTemplate(repo, {
      name: '12-month support plan', kind: 'revenue', method: 'straight_monthly',
      term_months: 12, start_rule: 'service_start',
      description: 'Support billed a year ahead, earned a month at a time.',
    });
    const annualLicence = schedules.createTemplate(repo, {
      name: 'Annual licence (daily)', kind: 'revenue', method: 'straight_daily',
      term_months: 12, start_rule: 'service_start',
      description: 'Pro-rated by day, so a mid-month start lands exactly.',
    });
    const prepaidCover = schedules.createTemplate(repo, {
      name: 'Annual insurance', kind: 'expense', method: 'straight_monthly',
      term_months: 12, start_rule: 'service_start',
      description: 'A year of cover paid in one go, expensed month by month.',
    });

    const supportItem = inv.createItem(repo, {
      sku: 'SUP-GOLD', name: 'Gold Support Plan (12 months)', type: 'service',
      base_price: 14400, income_account_id: num('4020'),
      revenue_template_id: supportPlan.id,
      description: 'Round-the-clock cover with a four-hour response.',
    });
    const licenceItem = inv.createItem(repo, {
      sku: 'LIC-PLAT', name: 'Platform Licence (annual)', type: 'service',
      base_price: 36500, income_account_id: num('4030'),
      revenue_template_id: annualLicence.id,
      description: 'Twelve months of platform access.',
    });
    const insuranceItem = inv.createItem(repo, {
      sku: 'INS-LIAB', name: 'Liability Insurance (annual)', type: 'service',
      purchase_price: 24000, expense_account_id: num('6700'),
      expense_template_id: prepaidCover.id,
      description: 'Public and product liability cover.',
    });

    const yearStart = `${fiscalYear}-01-01`;
    const deferredCustomers = repo.query('SELECT id FROM customer WHERE tenant_id = :t ORDER BY created_at LIMIT 3');
    deferredCustomers.forEach((c, i) => {
      const start = addMonths(yearStart, i);
      T.createTxn(repo, 'INVOICE', {
        entity_id: c.id, txn_date: start,
        memo: i === 0 ? 'Gold support renewal' : 'Platform licence renewal',
        lines: [{
          item_id: i === 0 ? supportItem.id : licenceItem.id, quantity: 1,
          unit_price: i === 0 ? 14400 : 36500,
          service_start: i === 0 ? start : addDays(start, 14),
          service_end: addDays(addMonths(i === 0 ? start : addDays(start, 14), 12), -1),
        }],
      });
    });

    const insurer = repo.queryOne('SELECT id FROM vendor WHERE tenant_id = :t ORDER BY created_at LIMIT 1');
    if (insurer) {
      T.createTxn(repo, 'VENDOR_BILL', {
        entity_id: insurer.id, subsidiary_id: usSubId, txn_date: yearStart,
        memo: 'Annual liability cover',
        lines: [{
          item_id: insuranceItem.id, quantity: 1, unit_price: 24000,
          service_start: yearStart, service_end: `${fiscalYear}-12-31`,
        }],
      });
    }

    // Caught up to the end of the month before last, which leaves exactly one
    // month due: the screen opens with history behind it and a real run
    // waiting, rather than a disabled button and nothing to look at.
    const caughtUpTo = addDays(startOfMonth(addMonths(today(), -1)), -1);
    schedules.runRecognition(repo, { kind: 'revenue', through: caughtUpTo });
    schedules.runRecognition(repo, { kind: 'expense', through: caughtUpTo });

    // --- standing entries and a month-end accrual
    // Rent goes out on the first of every month and never changes. The
    // utilities accrual is the other half of the pattern: booked at period
    // end against an estimate, unwound the next day so the bill that arrives
    // in the following week is not counted twice.
    recurring.createRecurring(repo, {
      name: 'Office rent', subsidiary_id: usSubId, memo: 'Head office lease',
      frequency: 'monthly', day_rule: 'day_of_month', day_of_month: 1,
      start_date: yearStart, auto_reverse: false,
      lines: [
        { account_id: num('6100'), debit: 8500, memo: 'Head office lease' },
        { account_id: num('1010'), credit: 8500, memo: 'Standing order' },
      ],
    });
    recurring.createRecurring(repo, {
      name: 'Utilities accrual', subsidiary_id: usSubId, memo: 'Estimated power and water',
      frequency: 'monthly', day_rule: 'month_end', start_date: yearStart, auto_reverse: true,
      lines: [
        { account_id: num('6110'), debit: 1450, memo: 'Estimated for the month' },
        { account_id: num('2020'), credit: 1450, memo: 'Accrued utilities' },
      ],
    });
    recurring.createRecurring(repo, {
      name: 'Quarterly audit fee accrual', subsidiary_id: usSubId, memo: 'Audit fee, accrued quarterly',
      frequency: 'quarterly', day_rule: 'month_end', start_date: yearStart, auto_reverse: true,
      lines: [
        { account_id: num('6400'), debit: 6000, memo: 'Audit fee' },
        { account_id: num('2020'), credit: 6000, memo: 'Accrued professional fees' },
      ],
    });
    recurring.generate(repo, { through: caughtUpTo });

    // --- last month's currency revaluation, already posted and reversed
    // Whichever entity holds foreign balances gets a run; the screen should
    // open with one behind it and this month's exposure still to do.
    for (const sub of repo.query('SELECT id FROM subsidiary WHERE tenant_id = :t AND active = 1')) {
      try {
        revaluation.run(repo, { as_of: caughtUpTo, subsidiary_id: sub.id, memo: 'Month-end revaluation' });
      } catch { /* nothing foreign on this entity's books */ }
    }

    // --- the collections desk, part way through a cycle
    // Two collectors with accounts on their desks, one customer who has
    // promised to pay, one nobody is allowed to chase, two rounds of letters
    // already out, and a provision standing against what will not arrive.
    const collectors = repo.query(
      `SELECT id FROM employee WHERE tenant_id = :t AND status = 'active' ORDER BY created_at LIMIT 2`);
    const desk = collections.worklist(repo, { as_of: today() }).rows;
    desk.slice(0, 8).forEach((r, i) => {
      collections.updateCollectionState(repo, r.customer_id, {
        collector_id: collectors[i % Math.max(1, collectors.length)]?.id || null,
      });
    });
    if (desk[1]) {
      collections.updateCollectionState(repo, desk[1].customer_id, {
        promise_date: addDays(now, 9), promise_amount: Money.toNumber(desk[1].overdue),
        collection_note: 'Spoke to their finance manager — payment run is on the 15th.',
      });
    }
    if (desk[3]) {
      collections.updateCollectionState(repo, desk[3].customer_id, {
        no_dunning: 1, collection_note: 'Long-standing account, handled by the sales director personally.',
      });
    }
    collections.runDunning(repo, { as_of: addDays(now, -24) });
    collections.runDunning(repo, { as_of: addDays(now, -11) });
    collections.allowance(repo, { as_of: caughtUpTo, memo: 'Month-end provision' });

    // --- statistical accounts and an allocation that follows them
    // Rent and IT belong to every department; splitting them by headcount is
    // the example everybody recognises, and it needs a statistic to divide by.
    const headcount = gl.createAccount(repo, {
      number: '9100', name: 'Headcount', type: 'EXPENSE', subtype: 'OPERATING_EXPENSE',
      is_statistical: 1, statistical_unit: 'people',
      description: 'People per department, for allocating shared cost.',
    });
    const deptList = repo.query("SELECT id, name FROM department WHERE tenant_id = :t AND name IN ('Sales','Operations','Finance','Engineering') ORDER BY name");
    if (deptList.length >= 2) {
      allocations.postStatistic(repo, {
        account_id: headcount.id, subsidiary_id: usSubId, txn_date: startOfMonth(now),
        memo: 'Headcount at the start of the month',
        entries: deptList.map((d, i) => ({ department_id: d.id, quantity: [14, 22, 6, 18][i % 4] })),
      });
      const byHeadcount = allocations.createSchedule(repo, {
        name: 'Facilities by headcount', subsidiary_id: usSubId, method: 'statistical',
        description: 'Rent and utilities across the departments that sit in the building.',
        frequency: 'monthly', basis: 'period', start_date: caughtUpTo,
        sources: [{ account_id: num('6100') }, { account_id: num('6110') }],
        targets: deptList.map((d) => ({ department_id: d.id, statistical_account_id: headcount.id })),
      });
      try { allocations.run(repo, byHeadcount.id, { txn_date: caughtUpTo }); } catch { /* nothing landed that month */ }
    }

    // --- a stock count part way through, so the screen opens with work on it
    try {
      const countLocation = repo.queryOne('SELECT id FROM location WHERE tenant_id = :t ORDER BY created_at LIMIT 1');
      const count = costing.openCount(repo, {
        location_id: countLocation.id, subsidiary_id: usSubId, scope: 'cycle', size: 12,
        count_date: today(), name: 'Weekly cycle count',
      });
      // Most lines agree; a couple do not, which is what a count is for.
      costing.enterCounts(repo, count.id, count.lines.slice(0, 8).map((l, i) => ({
        id: l.id,
        counted_qty: Qty.toNumber(l.expected_qty) + (i === 2 ? -3 : i === 5 ? 2 : 0),
        note: i === 2 ? 'Two boxes damaged, one missing' : '',
      })));
    } catch { /* nothing stocked to count in this seed run */ }

    // --- a supplier payment run, already paid, and one sitting in the drawer
    // Two suppliers are held: one under a quality dispute, one waiting on a
    // bank mandate. They stay on the run, unticked, so the hold is visible.
    const suppliers = repo.query('SELECT id, name FROM vendor WHERE tenant_id = :t ORDER BY created_at');
    if (suppliers[2]) repo.update('vendor', suppliers[2].id, { payment_hold: 1, updated_at: nowIso() });
    suppliers.forEach((v, i) => {
      repo.update('vendor', v.id, {
        payment_method: i % 5 === 0 ? 'cheque' : 'bank_transfer',
        bank_reference: `GB${29 + (i % 40)} MERI 6016 1331 926${i % 10}`,
        remittance_email: `payments@${v.name.toLowerCase().replace(/[^a-z0-9]+/g, '')}.test`.slice(0, 60),
        updated_at: nowIso(),
      });
    });

    const operating = repo.queryOne('SELECT id FROM bank_account WHERE tenant_id = :t ORDER BY created_at LIMIT 1');
    if (operating) {
      try {
        const lastRun = payruns.proposeRun(repo, {
          bank_account_id: operating.id, payment_date: addDays(now, -14),
          pay_through: addDays(now, -14), memo: 'Fortnightly supplier run',
        });
        payruns.commitRun(repo, lastRun.id);
      } catch { /* nothing was due that far back in this seed run */ }
      try {
        payruns.proposeRun(repo, {
          bank_account_id: operating.id, payment_date: addDays(now, 3),
          pay_through: addDays(now, 10), memo: 'Fortnightly supplier run',
        });
      } catch { /* nothing due in the window */ }
    }

    // --- the sales tax returns already filed this year
    // Each quarter that has entirely passed is filed, leaving the current one
    // open with real figures in it and a late item or two to explain.
    for (const [q, from, to] of [
      [1, `${fiscalYear}-01-01`, `${fiscalYear}-03-31`],
      [2, `${fiscalYear}-04-01`, `${fiscalYear}-06-30`],
      [3, `${fiscalYear}-07-01`, `${fiscalYear}-09-30`],
    ]) {
      if (to >= today()) break;
      try {
        tax.fileReturn(repo, {
          period_from: from, period_to: to,
          reference: `AUTH-${fiscalYear}-Q${q}`,
          note: `Quarter ${q} ${fiscalYear}`,
        });
      } catch { /* nothing taxable in that quarter */ }
    }

    // --- a performance review round, part way through
    const cycle = workforce.createCycle(repo, {
      name: `Mid-year review ${fiscalYear}`,
      period_start: `${fiscalYear}-01-01`, period_end: `${fiscalYear}-06-30`,
      due_date: addDays(now, 21), rating_scale: 5,
      template: [
        { competency: 'Delivery', weight: 3 },
        { competency: 'Collaboration', weight: 2 },
        { competency: 'Customer focus', weight: 2 },
        { competency: 'Craft', weight: 3 },
      ],
    });
    workforce.openCycle(repo, cycle.id);
    const reviews = repo.query('SELECT id FROM performance_review WHERE tenant_id = :t AND cycle_id = ? ORDER BY created_at', [cycle.id]);
    reviews.forEach((rv, i) => {
      if (i % 3 === 2) return;                      // a third are still to do
      workforce.submitReview(repo, rv.id, {
        by: 'manager',
        ratings: [
          { competency: 'Delivery', rating: 3 + (i % 3 === 0 ? 1 : 0) },
          { competency: 'Collaboration', rating: 4 },
          { competency: 'Customer focus', rating: 3 + (i % 2) },
          { competency: 'Craft', rating: 4 - (i % 2) },
        ],
        strengths: 'Dependable through a heavy quarter; strong with customers under pressure.',
        development: 'Delegate more of the routine work and write things down sooner.',
        goals: [{ goal: 'Lead one customer migration end to end', due: addDays(now, 120) }],
      });
      if (i % 3 === 0) workforce.acknowledgeReview(repo, rv.id);
    });
  });

  // ================================================== subscription billing
  // Recurring revenue behaves unlike anything else in the demo: the same
  // contract bills every month, the seats on it move part way through a term,
  // and what was metered is only known after the fact. Seeded with real
  // history behind it and exactly one period waiting, so the screen opens
  // with a run to do rather than a disabled button.
  transaction(db, () => {
    const num = (n) => repo.queryOne('SELECT id FROM account WHERE tenant_id = :t AND number = ?', [n])?.id;
    const recurringRev = num('4020');
    const usageRev = num('4030');

    const seat = inv.createItem(repo, {
      sku: 'SUB-SEAT', name: 'Platform Seat', type: 'service', category: 'Subscriptions', uom: 'EA',
      base_price: 45, income_account_id: recurringRev,
      description: 'One named user. Billed for the period ahead, prorated when seats move mid-term.',
    });
    const platform = inv.createItem(repo, {
      sku: 'SUB-PLATFORM', name: 'Platform Base Fee', type: 'service', category: 'Subscriptions', uom: 'EA',
      base_price: 1200, income_account_id: recurringRev,
      description: 'The standing charge the seats sit on top of.',
    });
    // Priced per thousand rather than per call: money is held to the cent, so
    // a rate of $0.004 would round to nothing. Per-thousand is how metered
    // pricing is quoted anyway.
    const apiCalls = inv.createItem(repo, {
      sku: 'SUB-API', name: 'API Calls (per 1,000)', type: 'service', category: 'Subscriptions', uom: 'K',
      base_price: 4, income_account_id: usageRev,
      description: 'Charged for what was actually used, in arrears, above the included allowance.',
    });
    const onboarding = inv.createItem(repo, {
      sku: 'SUB-ONBOARD', name: 'Onboarding & Migration', type: 'service', category: 'Subscriptions', uom: 'EA',
      base_price: 6500, income_account_id: recurringRev,
      description: 'Charged once, at the start of the contract.',
    });

    const customers = repo.query('SELECT id, name, currency FROM customer WHERE tenant_id = :t ORDER BY created_at LIMIT 24');
    const start = startOfMonth(addMonths(today(), -5));
    // Everything is billed to the end of last month. The current period is
    // the one still owed.
    const caughtUp = addDays(startOfMonth(today()), -1);
    const midTerm = startOfMonth(addMonths(today(), -2));
    const beforeMid = addDays(midTerm, -1);

    // seats, base fee, metered, one-off, frequency, term, billing day, advance
    const plans = [
      // meter is the included allowance, in thousands of calls.
      { c: 0,  seats: 120, base: true,  meter: 400,  setup: true,  freq: 'monthly',   term: 12, day: 1 },
      { c: 1,  seats: 45,  base: true,  meter: 0,    setup: false, freq: 'monthly',   term: 12, day: 1 },
      { c: 2,  seats: 300, base: true,  meter: 1000, setup: true,  freq: 'annually',  term: 24, day: 0 },
      { c: 3,  seats: 24,  base: false, meter: 0,    setup: false, freq: 'monthly',   term: 0,  day: 1 },
      { c: 4,  seats: 80,  base: true,  meter: 250,  setup: false, freq: 'quarterly', term: 12, day: 0 },
      { c: 5,  seats: 18,  base: false, meter: 0,    setup: true,  freq: 'monthly',   term: 6,  day: 1 },
      { c: 6,  seats: 210, base: true,  meter: 0,    setup: false, freq: 'monthly',   term: 6,  day: 0 },
      { c: 7,  seats: 36,  base: true,  meter: 120,  setup: false, freq: 'monthly',   term: 12, day: 1 },
      { c: 8,  seats: 15,  base: false, meter: 0,    setup: false, freq: 'monthly',   term: 12, day: 1 },
      { c: 9,  seats: 64,  base: true,  meter: 0,    setup: true,  freq: 'quarterly', term: 24, day: 1 },
    ];

    const made = [];
    for (const p of plans) {
      const cust = customers[p.c];
      if (!cust) continue;
      const lines = [];
      if (p.base) lines.push({ item_id: platform.id, quantity: 1, unit_price: 1200, description: 'Platform base fee' });
      lines.push({ item_id: seat.id, quantity: p.seats, unit_price: 45, description: `Platform seats (${p.seats})` });
      if (p.meter) {
        lines.push({
          item_id: apiCalls.id, model: 'usage', quantity: 0, unit_price: 4,
          usage_uom: 'k calls', included_quantity: p.meter,
          description: `API calls above ${p.meter}k included`,
        });
      }
      if (p.setup) lines.push({ item_id: onboarding.id, model: 'one_time', quantity: 1, unit_price: 6500, description: 'Onboarding & migration' });

      const s = subscriptions.createSubscription(repo, {
        customer_id: cust.id,
        name: `${cust.name} — Platform`,
        start_date: start, term_months: p.term,
        billing_frequency: p.freq, billing_day: p.day,
        auto_renew: p.c % 4 !== 2,
        po_number: p.c % 3 === 0 ? `PO-${between(40000, 99999)}` : '',
        memo: 'Seeded contract.',
        lines, activate: true,
      });
      made.push(s);
    }

    // --- what was metered, month by month, before any of it was billed
    for (const s of made) {
      const metered = s.lines.filter((l) => l.model === 'usage');
      for (const l of metered) {
        for (let m = 5; m >= 1; m -= 1) {
          const when = addDays(startOfMonth(addMonths(today(), -m)), between(3, 24));
          subscriptions.recordUsage(repo, s.id, {
            line_id: l.id, usage_date: when,
            quantity: Math.round(l.included_quantity / 1e6 * (0.7 + R() * 0.9)),
            memo: 'Metered by the platform',
          });
        }
      }
    }

    // Bill the first half of the history, so the amendments that follow land
    // on a contract that has already invoiced — which is the case that is
    // actually hard, and the one the screen has to explain.
    subscriptions.runBilling(repo, { through: beforeMid });

    // --- the contracts move: seats added, a price held, a block given up
    if (made[0]) {
      subscriptions.amend(repo, made[0].id, {
        kind: 'quantity', line_id: made[0].lines.find((l) => l.item_id === seat.id).id,
        quantity: 165, effective_date: midTerm, note: 'Second team onboarded.',
      });
    }
    if (made[4]) {
      subscriptions.amend(repo, made[4].id, {
        kind: 'price', line_id: made[4].lines.find((l) => l.item_id === seat.id).id,
        unit_price: 39, effective_date: midTerm, note: 'Volume discount agreed at renewal talks.',
      });
    }
    if (made[7]) {
      subscriptions.amend(repo, made[7].id, {
        kind: 'add', effective_date: midTerm, note: 'Added premium support.',
        line: { item_id: platform.id, quantity: 1, unit_price: 350, description: 'Premium support uplift' },
      });
    }
    if (made[3]) {
      subscriptions.amend(repo, made[3].id, {
        kind: 'quantity', line_id: made[3].lines.find((l) => l.item_id === seat.id).id,
        quantity: 16, effective_date: midTerm, note: 'Contractors rolled off.',
      });
    }

    // Catch the rest up. One period is now due on every live contract.
    subscriptions.runBilling(repo, { through: caughtUp });

    // --- not every contract is healthy
    if (made[8]) subscriptions.suspend(repo, made[8].id, { reason: 'Invoices unpaid past ninety days; billing held pending payment.' });
    if (made[5]) {
      subscriptions.cancel(repo, made[5].id, {
        effective_date: addDays(today(), 14),
        reason: 'Consolidating onto the parent group agreement.',
      });
    }
  });

  // ================================================== intercompany
  // Two trading companies in one group means they trade with each other: the
  // parent recharges head-office cost, and sells support the UK resells. Both
  // sides of each are posted, and the older periods are eliminated so the
  // consolidated view already nets to nothing while the recent ones still
  // have a run waiting to be done.
  transaction(db, () => {
    const usSubId = repo.queryOne('SELECT id FROM subsidiary WHERE tenant_id = :t AND parent_id IS NULL').id;
    const num = (n) => repo.queryOne('SELECT id FROM account WHERE tenant_id = :t AND number = ?', [n])?.id;
    intercompany.eliminationSubsidiary(repo, { create: true });

    const groupServices = inv.createItem(repo, {
      sku: 'IC-PLATFORM', name: 'Group Platform Services', type: 'service',
      category: 'Intercompany', base_price: 9500, income_account_id: num('4020'),
      expense_account_id: num('6500'),
      description: 'Sold by the parent to the other companies in the group at cost plus a margin.',
    });

    // Head office cost, recharged monthly to the company that benefits from it.
    for (let m = 5; m >= 1; m -= 1) {
      const when = addDays(startOfMonth(addMonths(today(), -m)), 27);
      const amount = Money.parse(between(11000, 14500));
      intercompany.intercompanyJournal(repo, {
        from_subsidiary_id: usSubId, to_subsidiary_id: ukSub, txn_date: when,
        memo: `Head office recharge — ${when.slice(0, 7)}`,
        lines: [
          // The UK bears the cost; the parent recovers what it laid out.
          { subsidiary_id: ukSub, account_id: num('6500'), debit: amount },
          { subsidiary_id: usSubId, account_id: num('4020'), credit: amount },
        ],
      });
    }

    // And a real sale between the two: an invoice one side, a bill the other.
    for (let m = 4; m >= 1; m -= 2) {
      const when = addDays(startOfMonth(addMonths(today(), -m)), 9);
      intercompany.intercompanySale(repo, {
        from_subsidiary_id: usSubId, to_subsidiary_id: ukSub, txn_date: when,
        memo: 'Platform services for resale',
        lines: [{ item_id: groupServices.id, quantity: between(2, 5), unit_price: 9500 }],
      });
    }

    // Everything up to two months ago is eliminated; what is left is a run
    // somebody still has to do, which is what the screen opens on.
    for (let m = 5; m >= 3; m -= 1) {
      const period = gl.periodForDate(repo, startOfMonth(addMonths(today(), -m)));
      if (!period || period.status !== 'open') continue;
      try { intercompany.runElimination(repo, { period_id: period.id }); } catch { /* nothing in it */ }
    }
  });

  // ================================================== custom records
  // Two registers this company keeps that Meridian does not ship with. They
  // are here because the feature is invisible until you see one: a custom
  // type looks and behaves exactly like a built-in record, which is the whole
  // claim being made.
  transaction(db, () => {
    const defineType = (type, fields) => {
      const made = customrecords.createType(repo, type);
      fields.forEach((f, i) => platform.createCustomField(repo, {
        record_type: customrecords.qualified(made.name), display_order: i + 1, ...f,
      }));
      return made;
    };

    defineType({
      name: 'calibration_cert', label: 'Calibration Certificate',
      plural: 'Calibration Certificates', nav_group: 'Inventory', icon: '◎',
      description: 'Proof that a gauge reads true. Kept because the auditor asks for it.',
      numbered: true, number_prefix: 'CAL-',
    }, [
      { name: 'serial', label: 'Instrument serial', type: 'text', required: 1, show_in_list: 1 },
      { name: 'calibrated_on', label: 'Calibrated', type: 'date', show_in_list: 1 },
      { name: 'expires_on', label: 'Expires', type: 'date', show_in_list: 1 },
      { name: 'certified_by', label: 'Certified by', type: 'text' },
      { name: 'result', label: 'Result', type: 'select', options: ['Pass', 'Pass with adjustment', 'Fail'], show_in_list: 1 },
      { name: 'notes', label: 'Notes', type: 'longtext' },
    ]);

    defineType({
      name: 'approved_subcontractor', label: 'Approved Subcontractor',
      plural: 'Approved Subcontractors', nav_group: 'Purchasing', icon: '⚒',
      description: 'Who is allowed on site, and until when.',
    }, [
      { name: 'trade', label: 'Trade', type: 'select', options: ['Electrical', 'Mechanical', 'Civil', 'Fit-out', 'Testing'], show_in_list: 1 },
      { name: 'insurance_expires', label: 'Insurance expires', type: 'date', required: 1, show_in_list: 1 },
      { name: 'day_rate', label: 'Agreed day rate', type: 'money', show_in_list: 1 },
      { name: 'contact_email', label: 'Contact', type: 'text' },
      { name: 'vetted', label: 'Vetting complete', type: 'checkbox' },
    ]);

    const instruments = [
      ['Torque wrench, bay 2', 'TW-88120', 'Pass'],
      ['Pressure gauge, line 4', 'PG-40217', 'Pass'],
      ['Multimeter, test bench', 'MM-11904', 'Pass with adjustment'],
      ['Bore micrometer, QA', 'BM-77310', 'Pass'],
      ['Flow meter, line 1', 'FM-20655', 'Fail'],
    ];
    instruments.forEach(([name, serial, result], i) => {
      const calibrated = addDays(today(), -between(40, 330));
      records.createRecord(repo, customrecords.qualified('calibration_cert'), {
        name, serial, result,
        calibrated_on: calibrated,
        expires_on: addMonths(calibrated, 12),
        certified_by: pick(['Metrology Partners Ltd', 'Calibrate UK', 'Precision Assurance']),
        notes: result === 'Fail' ? 'Withdrawn from service pending repair.' : '',
        active: i !== 4 ? 1 : 0,
      });
    });

    const subbies = [
      ['Hale Electrical', 'Electrical', 620],
      ['Ferndale Mechanical', 'Mechanical', 580],
      ['Ashworth Civils', 'Civil', 540],
      ['Redgate Fit-Out', 'Fit-out', 495],
      ['Thorne Testing Services', 'Testing', 710],
    ];
    subbies.forEach(([name, trade, rate], i) => {
      records.createRecord(repo, customrecords.qualified('approved_subcontractor'), {
        name, trade, day_rate: rate,
        insurance_expires: addDays(today(), between(20, 400)),
        contact_email: `contracts@${name.toLowerCase().replace(/[^a-z]/g, '')}.test`,
        vetted: i !== 3,
        active: 1,
      });
    });
  });

  // ================================================== a second set of books
  // The company reports to its parent under IFRS and files locally under US
  // GAAP. Same transactions, two opinions: assets last longer under IFRS, and
  // one licence deal is earned later. Seeded so the two bases visibly differ,
  // which is the only way to see what the feature is for.
  transaction(db, () => {
    const usSubId = repo.queryOne('SELECT id FROM subsidiary WHERE tenant_id = :t AND parent_id IS NULL').id;
    const num = (n) => repo.queryOne('SELECT id FROM account WHERE tenant_id = :t AND number = ?', [n])?.id;

    const ifrs = books.createBook(repo, {
      name: 'IFRS', code: 'IFRS', purpose: 'Group reporting',
      description: 'What the parent consolidates. Differs from the filed accounts on useful lives and on when one licence is earned.',
    });

    // Fit-out and plant are written off faster locally than the group thinks
    // they last. That difference is the classic reason to keep two books.
    const longerLived = repo.query(
      `SELECT a.id, a.life_months FROM fixed_asset a
       WHERE a.tenant_id = :t AND a.status = 'active' AND a.life_months <= 60
       ORDER BY a.cost DESC LIMIT 3`);
    for (const a of longerLived) {
      books.setAssetRule(repo, {
        book_id: ifrs.id, asset_id: a.id, method: 'STRAIGHT_LINE',
        life_months: a.life_months * 2,
        note: 'Useful life reassessed on group adoption of IFRS.',
      });
    }
    books.runBookDepreciation(repo, { book_id: ifrs.id, through: today() });

    // And one revenue judgement: a licence billed up front that the group
    // considers earned over the year rather than on delivery.
    const lastOpen = repo.queryOne(
      `SELECT id, end_date FROM accounting_period
       WHERE tenant_id = :t AND status = 'open' AND end_date <= ?
       ORDER BY end_date DESC LIMIT 1`, [today()]);
    if (lastOpen) {
      books.postAdjustment(repo, {
        book_id: ifrs.id, subsidiary_id: usSubId, txn_date: lastOpen.end_date,
        memo: 'Platform licence earned over the term rather than on delivery',
        lines: [
          { account_id: num('4030'), base_debit: Money.parse(28000) },
          { account_id: num('2300'), base_credit: Money.parse(28000) },
        ],
      });
    }
  });

  // ================================================== bank statement
  transaction(db, () => {
    const ba = repo.queryOne('SELECT * FROM bank_account WHERE tenant_id = :t LIMIT 1');
    const recent = repo.query(`SELECT je.txn_date, jl.base_debit, jl.base_credit, je.memo
        FROM journal_line jl JOIN journal_entry je ON je.tenant_id = jl.tenant_id AND je.id = jl.entry_id
        WHERE jl.tenant_id = :t AND jl.account_id = ? AND je.txn_date >= ?
        ORDER BY je.txn_date DESC LIMIT 45`, [ba.account_id, addDays(now, -45)]);
    const lines = recent.map((l) => ({
      date: l.txn_date,
      description: (l.memo || 'Transfer').slice(0, 70),
      amount: Money.toNumber((l.base_debit || 0) - (l.base_credit || 0)),
    })).filter((l) => l.amount !== 0);
    // A couple of bank-only lines (fees) that will not auto-match, so the
    // reconciliation screen has genuine work to do.
    lines.push({ date: addDays(now, -6), description: 'Account maintenance fee', amount: -45 });
    lines.push({ date: addDays(now, -20), description: 'Interest earned', amount: 218.4 });
    if (lines.length) bank.importStatement(repo, ba.id, lines, { source: 'seed' });
  });
}
