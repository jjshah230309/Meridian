// Meridian ERP :: modules/setup
// Tenant provisioning: chart of accounts, roles, periods, currencies,
// subsidiaries, price levels and the owner account. Idempotent per tenant.
import { ulid, nowIso, today } from '../core/util.mjs';
import { hashPassword, passwordProblems } from '../core/auth.mjs';
import { Repo } from '../core/db.mjs';
import { ROLE_TEMPLATES, LEVEL } from '../core/rbac.mjs';
import { ValidationError, conflict } from '../core/http.mjs';
import * as gl from './gl.mjs';

/**
 * A US-GAAP-shaped default chart of accounts.
 * [number, name, type, subtype, isSummary?, cashFlowCategory?]
 */
export const DEFAULT_COA = [
  ['1000', 'Assets', 'ASSET', 'OTHER_ASSET', 1],
  ['1010', 'Operating Bank Account', 'ASSET', 'BANK', 0, 'operating'],
  ['1020', 'Payroll Bank Account', 'ASSET', 'BANK', 0, 'operating'],
  ['1030', 'Petty Cash', 'ASSET', 'BANK', 0, 'operating'],
  ['1100', 'Accounts Receivable', 'ASSET', 'AR', 0, 'operating'],
  ['1150', 'Allowance for Doubtful Accounts', 'ASSET', 'OTHER_CURRENT_ASSET', 0, 'operating'],
  ['1200', 'Inventory Asset', 'ASSET', 'INVENTORY', 0, 'operating'],
  ['1210', 'Work in Progress', 'ASSET', 'WIP', 0, 'operating'],
  ['1190', 'Due from Affiliates', 'ASSET', 'OTHER_CURRENT_ASSET', 0, 'operating', 1],
  ['1250', 'Prepaid Expenses', 'ASSET', 'OTHER_CURRENT_ASSET', 0, 'operating'],
  ['1260', 'Supplier Prepayments', 'ASSET', 'OTHER_CURRENT_ASSET', 0, 'operating'],
  ['1300', 'Undeposited Funds', 'ASSET', 'OTHER_CURRENT_ASSET', 0, 'operating'],
  ['1500', 'Property, Plant & Equipment', 'ASSET', 'FIXED_ASSET', 0, 'investing'],
  ['1590', 'Accumulated Depreciation', 'ASSET', 'ACCUMULATED_DEPRECIATION', 0, 'investing'],
  ['2000', 'Liabilities', 'LIABILITY', 'OTHER_CURRENT_LIABILITY', 1],
  ['2010', 'Accounts Payable', 'LIABILITY', 'AP', 0, 'operating'],
  ['2020', 'Accrued Liabilities', 'LIABILITY', 'OTHER_CURRENT_LIABILITY', 0, 'operating'],
  ['2030', 'Accrued Inventory Receipts', 'LIABILITY', 'OTHER_CURRENT_LIABILITY', 0, 'operating'],
  ['2100', 'Sales Tax Payable', 'LIABILITY', 'TAX_LIABILITY', 0, 'operating'],
  ['2200', 'Payroll Liabilities', 'LIABILITY', 'PAYROLL_LIABILITY', 0, 'operating'],
  ['2210', 'Employee Tax Withheld', 'LIABILITY', 'PAYROLL_LIABILITY', 0, 'operating'],
  ['2220', 'Employer Tax Payable', 'LIABILITY', 'PAYROLL_LIABILITY', 0, 'operating'],
  ['2300', 'Deferred Revenue', 'LIABILITY', 'OTHER_CURRENT_LIABILITY', 0, 'operating'],
  ['2190', 'Due to Affiliates', 'LIABILITY', 'OTHER_CURRENT_LIABILITY', 0, 'operating', 1],
  ['2350', 'Customer Deposits', 'LIABILITY', 'OTHER_CURRENT_LIABILITY', 0, 'operating'],
  ['2500', 'Notes Payable', 'LIABILITY', 'LONG_TERM_LIABILITY', 0, 'financing'],
  ['3000', 'Equity', 'EQUITY', 'OWNER_EQUITY', 1],
  ['3010', 'Common Stock', 'EQUITY', 'COMMON_STOCK', 0, 'financing'],
  ['3020', 'Additional Paid-in Capital', 'EQUITY', 'COMMON_STOCK', 0, 'financing'],
  ['3800', 'Cumulative Translation Adjustment', 'EQUITY', 'OWNER_EQUITY', 0, 'financing'],
  ['3850', 'Revaluation Reserve', 'EQUITY', 'OWNER_EQUITY', 0, 'financing'],
  ['3900', 'Retained Earnings', 'EQUITY', 'RETAINED_EARNINGS', 0, 'financing'],
  ['4000', 'Income', 'INCOME', 'REVENUE', 1],
  ['4010', 'Product Revenue', 'INCOME', 'REVENUE'],
  ['4020', 'Service Revenue', 'INCOME', 'REVENUE'],
  ['4030', 'Subscription Revenue', 'INCOME', 'REVENUE'],
  ['4900', 'Sales Discounts', 'INCOME', 'REVENUE'],
  ['4950', 'Shipping Income', 'INCOME', 'OTHER_INCOME'],
  ['5000', 'Cost of Goods Sold', 'EXPENSE', 'COGS', 1],
  ['5010', 'Product COGS', 'EXPENSE', 'COGS'],
  ['5020', 'Freight & Duty', 'EXPENSE', 'COGS'],
  ['5030', 'Inventory Shrinkage', 'EXPENSE', 'COGS'],
  ['5040', 'Manufacturing Variance', 'EXPENSE', 'COGS'],
  ['5050', 'Direct Labour Absorbed', 'EXPENSE', 'COGS'],
  ['5060', 'Manufacturing Overhead Absorbed', 'EXPENSE', 'COGS'],
  ['5070', 'Purchase Price Variance', 'EXPENSE', 'COGS'],
  ['6000', 'Operating Expenses', 'EXPENSE', 'OPERATING_EXPENSE', 1],
  ['6010', 'Salaries & Wages', 'EXPENSE', 'PAYROLL_EXPENSE'],
  ['6020', 'Employer Payroll Taxes', 'EXPENSE', 'PAYROLL_EXPENSE'],
  ['6030', 'Employee Benefits', 'EXPENSE', 'PAYROLL_EXPENSE'],
  ['6100', 'Rent & Facilities', 'EXPENSE', 'OPERATING_EXPENSE'],
  ['6110', 'Utilities', 'EXPENSE', 'OPERATING_EXPENSE'],
  ['6200', 'Marketing & Advertising', 'EXPENSE', 'OPERATING_EXPENSE'],
  ['6300', 'Software & Subscriptions', 'EXPENSE', 'OPERATING_EXPENSE'],
  ['6400', 'Professional Fees', 'EXPENSE', 'OPERATING_EXPENSE'],
  ['6500', 'Travel & Entertainment', 'EXPENSE', 'OPERATING_EXPENSE'],
  ['6600', 'Office Supplies', 'EXPENSE', 'OPERATING_EXPENSE'],
  ['6700', 'Insurance', 'EXPENSE', 'OPERATING_EXPENSE'],
  ['6800', 'Depreciation Expense', 'EXPENSE', 'OPERATING_EXPENSE'],
  ['6900', 'Bad Debt Expense', 'EXPENSE', 'OPERATING_EXPENSE'],
  ['7000', 'Other Income & Expense', 'EXPENSE', 'OTHER_EXPENSE', 1],
  ['7010', 'Interest Expense', 'EXPENSE', 'OTHER_EXPENSE'],
  ['7020', 'Bank Fees', 'EXPENSE', 'OTHER_EXPENSE'],
  ['7030', 'Realised FX Gain/Loss', 'EXPENSE', 'OTHER_EXPENSE'],
  ['7035', 'Unrealised FX Gain/Loss', 'EXPENSE', 'OTHER_EXPENSE'],
  ['7040', 'Rounding Difference', 'EXPENSE', 'OTHER_EXPENSE'],
  ['7050', 'Gain / Loss on Asset Disposal', 'EXPENSE', 'OTHER_EXPENSE'],
  ['7060', 'Impairment and Revaluation Loss', 'EXPENSE', 'OTHER_EXPENSE'],
];

export const DEFAULT_CURRENCIES = [
  ['USD', 'US Dollar', '$'], ['EUR', 'Euro', '€'], ['GBP', 'Pound Sterling', '£'],
  ['CAD', 'Canadian Dollar', 'CA$'], ['AUD', 'Australian Dollar', 'A$'],
  ['JPY', 'Japanese Yen', '¥', 0], ['INR', 'Indian Rupee', '₹'], ['AED', 'UAE Dirham', 'AED'],
  ['SGD', 'Singapore Dollar', 'S$'], ['CHF', 'Swiss Franc', 'CHF'],
];

/**
 * Countries offered by the first-run wizard, with the currency each one most
 * likely uses. Not an exhaustive list -- the currency is editable, and any
 * other country can be typed into company settings afterwards.
 */
export const SETUP_COUNTRIES = [
  ['US', 'United States', 'USD'], ['GB', 'United Kingdom', 'GBP'],
  ['AE', 'United Arab Emirates', 'AED'], ['CA', 'Canada', 'CAD'],
  ['AU', 'Australia', 'AUD'], ['IN', 'India', 'INR'],
  ['SG', 'Singapore', 'SGD'], ['CH', 'Switzerland', 'CHF'],
  ['JP', 'Japan', 'JPY'], ['IE', 'Ireland', 'EUR'],
  ['DE', 'Germany', 'EUR'], ['FR', 'France', 'EUR'],
  ['ES', 'Spain', 'EUR'], ['IT', 'Italy', 'EUR'],
  ['NL', 'Netherlands', 'EUR'],
].map(([code, name, currency]) => ({ code, name, currency }));

/** Posting-rule defaults, resolved by account number. */
export const POSTING_ACCOUNTS = {
  ar: '1100', ap: '2010', inventory: '1200', accrued_receipts: '2030',
  wip: '1210', sales_tax: '2100', product_revenue: '4010', service_revenue: '4020',
  discounts: '4900', shipping_income: '4950', cogs: '5010', shrinkage: '5030',
  mfg_variance: '5040', labour_absorbed: '5050', overhead_absorbed: '5060',
  purchase_variance: '5070', accrued_liabilities: '2020', travel: '6500',
  asset_disposal: '7050', prepaid_expenses: '1250', allowance_doubtful: '1150',
  bank: '1010', undeposited: '1300', retained_earnings: '3900',
  salaries: '6010', employer_tax: '6020', payroll_withheld: '2210',
  employer_tax_payable: '2220', fx: '7030', unrealised_fx: '7035',
  rounding: '7040', bad_debt: '6900',
  deferred_revenue: '2300',
  customer_deposits: '2350', supplier_prepayments: '1260',
  due_from_affiliates: '1190', due_to_affiliates: '2190',
  translation_adjustment: '3800',
  revaluation_reserve: '3850', impairment_loss: '7060',
};

/**
 * Create a tenant with everything needed to transact on day one.
 * Returns { tenant, owner, subsidiary, accounts }.
 */
export function provisionTenant(db, {
  name, slug, ownerEmail, ownerName = 'Administrator', ownerPassword,
  baseCurrency = 'USD', country = 'US', fiscalYear = new Date().getUTCFullYear(),
  plan = 'standard',
}) {
  if (!name) throw new ValidationError({ name: 'Company name is required' });
  if (!ownerEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ownerEmail)) throw new ValidationError({ ownerEmail: 'A valid owner email is required' });
  const pwIssues = passwordProblems(ownerPassword);
  if (pwIssues.length) throw new ValidationError({ ownerPassword: `Password ${pwIssues.join(', ')}` });

  const tenantSlug = slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  if (db.prepare('SELECT id FROM tenant WHERE slug = ?').get(tenantSlug)) {
    throw conflict(`A company with the address "${tenantSlug}" already exists`);
  }

  const tenantId = ulid();
  const now = nowIso();
  db.prepare(`INSERT INTO tenant (id, slug, name, plan, status, base_currency, fiscal_year_start_month, settings, data_region, created_at, updated_at)
              VALUES (?,?,?,?,'active',?,1,'{}','local',?,?)`)
    .run(tenantId, tenantSlug, name, plan, baseCurrency, now, now);

  const repo = new Repo(db, tenantId, {});

  // currencies
  for (const [code, cname, symbol, precision] of DEFAULT_CURRENCIES) {
    repo.exec('INSERT INTO currency (tenant_id, code, name, symbol, precision, active) VALUES (:t,?,?,?,?,?)',
      [code, cname, symbol, precision ?? 2, code === baseCurrency ? 1 : 1]);
  }

  // primary subsidiary
  const subsidiaryId = repo.insert('subsidiary', {
    id: ulid(), name, legal_name: name, parent_id: null, currency: baseCurrency,
    country, tax_number: '', address: {}, is_elimination: 0, active: 1, created_at: now,
  });

  // chart of accounts
  const accounts = {};
  const parents = {};
  for (const [number, aname, type, subtype, isSummary, cashFlow, intercompany] of DEFAULT_COA) {
    const parentNumber = number.endsWith('000') ? null : `${number[0]}000`;
    const id = repo.insert('account', {
      id: ulid(), number, name: aname, type, subtype: subtype || '',
      parent_id: parentNumber ? (parents[parentNumber] || null) : null,
      currency: null, subsidiary_id: null, is_summary: isSummary ? 1 : 0,
      cash_flow_category: cashFlow || '', description: '', active: 1,
      is_intercompany: intercompany ? 1 : 0,
      custom: {}, created_at: now, updated_at: now,
    });
    accounts[number] = id;
    if (isSummary) parents[number] = id;
  }

  // accounting periods: prior, current and next fiscal year
  for (const y of [fiscalYear - 1, fiscalYear, fiscalYear + 1]) gl.generatePeriods(repo, y, 1);

  // tax codes
  for (const [code, tname, rate] of [['STANDARD', 'Standard Rate', 0.0], ['EXEMPT', 'Exempt', 0.0], ['VAT20', 'VAT 20%', 20.0], ['GST5', 'GST 5%', 5.0], ['CA_SALES', 'CA Sales Tax', 7.25]]) {
    repo.exec('INSERT INTO tax_code (tenant_id, code, name, rate, account_id, country, active) VALUES (:t,?,?,?,?,?,1)',
      [code, tname, rate, accounts['2100'], country]);
  }

  // price levels
  const basePriceLevel = repo.insert('price_level', { id: ulid(), name: 'Base Price', discount_pct: 0, is_base: 1, active: 1 });
  repo.insert('price_level', { id: ulid(), name: 'Preferred (-10%)', discount_pct: 10, is_base: 0, active: 1 });
  repo.insert('price_level', { id: ulid(), name: 'Distributor (-25%)', discount_pct: 25, is_base: 0, active: 1 });

  // roles
  const roleIds = {};
  for (const tpl of ROLE_TEMPLATES) {
    const roleId = repo.insert('role', { id: ulid(), name: tpl.name, description: tpl.description, is_system: 1, created_at: now });
    roleIds[tpl.name] = roleId;
    for (const [recordType, level] of Object.entries(tpl.permissions)) {
      repo.exec('INSERT INTO permission (tenant_id, role_id, record_type, level) VALUES (:t,?,?,?)', [roleId, recordType, level]);
    }
    for (const r of tpl.restrictions || []) {
      repo.exec('INSERT INTO role_restriction (tenant_id, role_id, dimension, allowed, own_only) VALUES (:t,?,?,?,?)',
        [roleId, r.dimension, JSON.stringify(r.allowed || []), r.own_only ? 1 : 0]);
    }
  }

  // owner
  const { hash, salt } = hashPassword(ownerPassword);
  const ownerId = repo.insert('app_user', {
    id: ulid(), email: ownerEmail, name: ownerName, password_hash: hash, password_salt: salt,
    status: 'active', is_owner: 1, default_subsidiary_id: subsidiaryId,
    locale: 'en-US', timezone: 'UTC', created_at: now, updated_at: now,
  });
  repo.exec('INSERT INTO user_role (tenant_id, user_id, role_id) VALUES (:t,?,?)', [ownerId, roleIds.Administrator]);

  // main bank account
  repo.insert('bank_account', {
    id: ulid(), name: 'Operating Account', account_id: accounts['1010'], subsidiary_id: subsidiaryId,
    bank_name: '', number_masked: '', routing_masked: '', currency: baseCurrency, active: 1, created_at: now,
  });

  // Landed cost categories, so freight can be capitalised on the first
  // container rather than after somebody notices margins are wrong.
  for (const [name, method] of LANDED_COST_CATEGORIES) {
    repo.insert('landed_cost_category', {
      id: ulid(), name, method, account_id: accounts['5020'] || null, active: 1, created_at: now,
    });
  }

  // The primary accounting book. It stands for the ledger itself, and every
  // other book is expressed as a difference from it. Created here as well as
  // in the migration because a tenant provisioned in code is created after
  // the migrations have already run, so the migration's insert finds no
  // tenant to attach one to.
  repo.insert('accounting_book', {
    id: ulid(), name: 'Primary', code: 'PRIMARY', is_primary: 1,
    purpose: 'Statutory', basis: 'accrual',
    description: 'The ledger itself. Everything posts here; other books record only where they differ from it.',
    status: 'active', created_at: now, created_by: null, updated_at: now,
  });

  // a collections ladder, so chasing works the day the company is set up
  const dunningPolicyId = repo.insert('dunning_policy', {
    id: ulid(), name: 'Standard collections',
    description: 'Three rungs: a reminder, a firmer letter, then a final notice that puts the account on hold.',
    min_balance: 2500, cooldown_days: 7, is_default: 1, active: 1, created_at: now, updated_at: now,
  });
  for (const level of DUNNING_LEVELS) {
    repo.insert('dunning_level', { id: ulid(), policy_id: dunningPolicyId, ...level });
  }

  // default warehouse
  repo.insert('location', {
    id: ulid(), code: 'MAIN', name: 'Main Warehouse', subsidiary_id: subsidiaryId,
    address: {}, type: 'warehouse', makes_commitments: 1, active: 1, created_at: now,
  });

  return {
    tenant: db.prepare('SELECT * FROM tenant WHERE id = ?').get(tenantId),
    ownerId, subsidiaryId, accounts, roleIds, basePriceLevel, dunningPolicyId,
  };
}

/**
 * What arrives alongside a container besides the goods. Freight, duty and
 * insurance scale with what the shipment is worth; handling scales with how
 * many boxes there are.
 */
export const LANDED_COST_CATEGORIES = [
  ['Freight', 'value'], ['Duty', 'value'], ['Insurance', 'value'], ['Handling', 'quantity'],
];

/**
 * The default dunning ladder. Three rungs, each later and firmer than the
 * last, with the final one putting the account on hold -- which is the point
 * at which somebody in sales notices and picks up the phone.
 */
export const DUNNING_LEVELS = [
  {
    level_no: 1, name: 'Reminder', days_overdue: 7,
    subject: 'Reminder: {{overdue}} outstanding on account {{account}}',
    body: 'We have not yet received payment of {{overdue}} on account {{account}}, the oldest item being {{oldest_days}} days past due. If it has been paid in the last few days, thank you — please ignore this note. Otherwise the open items are listed below.',
    credit_hold: 0, charge_interest: 0,
  },
  {
    level_no: 2, name: 'Second request', days_overdue: 30,
    subject: 'Second request: {{overdue}} now {{oldest_days}} days overdue',
    body: 'Our reminder of {{last_notice_date}} has not been answered and {{overdue}} remains outstanding on account {{account}}, the oldest item now {{oldest_days}} days past due. Please arrange payment within seven days, or tell us when we can expect it so we can note the account.',
    credit_hold: 0, charge_interest: 0,
  },
  {
    level_no: 3, name: 'Final notice', days_overdue: 60,
    subject: 'Final notice: account {{account}} placed on hold',
    body: 'Despite two written reminders, {{overdue}} remains outstanding on account {{account}} and the oldest item is {{oldest_days}} days past due. The account has been placed on credit hold and no further orders will be released. Please settle the balance in full, or contact us within seven days to agree terms.',
    credit_hold: 1, charge_interest: 0,
  },
];

/** Resolve the posting account map for a tenant, by account number. */
export function postingAccounts(repo) {
  const rows = repo.query('SELECT id, number FROM account WHERE tenant_id = :t');
  const byNumber = Object.fromEntries(rows.map((r) => [r.number, r.id]));
  const out = {};
  for (const [k, num] of Object.entries(POSTING_ACCOUNTS)) out[k] = byNumber[num] || null;
  return out;
}
