import assert from 'node:assert';
import * as odata from '../src/modules/odata.mjs';
import * as soap from '../src/modules/soap.mjs';
import * as meta from '../src/modules/meta.mjs';
import * as rbac from '../src/core/rbac.mjs';

// Mock Repo to track queries
class RepoMock {
  constructor() {
    this.queries = [];
  }
  query(sql, params = []) {
    this.queries.push({ sql, params });
    return []; // Return empty results for now
  }
  queryOne(sql, params = []) {
    this.queries.push({ sql, params });
    return null;
  }
  get(table, id) {
    return null;
  }
}

async function testODataBulkReferences() {
  console.log('Testing OData Bulk Reference Labels...');
  const repo = new RepoMock();
  const access = { isOwner: true };

  // Setup metadata for test
  meta.RECORDS.customer = {
    table: 'customer',
    permission: 'customer',
    fields: [
      { name: 'name', type: 'text' },
      { name: 'address_id', type: 'reference', ref: 'address' },
    ],
  };
  meta.RECORDS.address = {
    table: 'address',
    permission: 'address',
    fields: [
      { name: 'city', type: 'text' },
    ],
  };
  meta.REF_LABEL.address = {
    table: 'address',
    cols: ['id', 'city'],
    label: (r) => r.city,
  };

  repo.query = (sql, params) => {
    repo.queries.push({ sql, params });
    if (sql.includes('SELECT r.* FROM customer')) {
      return [
        { id: '1', name: 'C1', address_id: 'a1' },
        { id: '2', name: 'C2', address_id: 'a2' },
        { id: '3', name: 'C3', address_id: 'a1' },
      ];
    }
    if (sql.includes('SELECT') && sql.includes('FROM address') && sql.includes('IN')) {
      return [
        { id: 'a1', city: 'City 1' },
        { id: 'a2', city: 'City 2' },
      ];
    }
    return [];
  };

  odata.readSet(repo, access, 'Customers', {});

  const addressQueries = repo.queries.filter(q => q.sql.includes('FROM address'));
  assert.strictEqual(addressQueries.length, 1, 'Should use a single bulk query for reference labels');
  console.log('✅ OData Bulk Reference Labels verified.');
}

async function testODataAnalyticPushdown() {
  console.log('Testing OData Analytic SQL Pushdown...');
  const repo = new RepoMock();
  const access = { isOwner: true };

  repo.query = (sql, params) => {
    repo.queries.push({ sql, params });
    return [];
  };

  odata.readSet(repo, access, 'ProfitAndLoss', { $filter: "AccountNumber eq '1000'" });

  const pnlQuery = repo.queries.find(q => q.sql.includes('FROM gl_balance'));
  assert.ok(pnlQuery, 'Should execute a query against gl_balance');
  assert.ok(pnlQuery.sql.includes('WHERE') && pnlQuery.sql.includes('AND'), 'Should have a WHERE clause with pushed-down filter');
  assert.ok(pnlQuery.params.includes('1000'), 'Should include the filter value in parameters');
  console.log('✅ OData Analytic SQL Pushdown verified.');
}

async function testSoapBulkFetching() {
  console.log('Testing SOAP Bulk Fetching...');
  const repo = new RepoMock();
  const access = { isOwner: true };
  const ctx = { repo, access };

  const body = `
    <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="urn:platform.meridian.erp">
      <soap:Body>
        <getList>
          <recordRef type="customer" internalId="1"/>
          <recordRef type="customer" internalId="2"/>
          <recordRef type="address" internalId="a1"/>
        </getList>
      </soap:Body>
    </soap:Envelope>
  `;

  // Ensure meta is set for SOAP tests
  meta.RECORDS.customer = { table: 'customer', permission: 'customer' };
  meta.RECORDS.address = { table: 'address', permission: 'address' };

  soap.handle(ctx, body);

  const customerQueries = repo.queries.filter(q => q.sql.includes('FROM customer') && q.sql.includes('IN'));
  const addressQueries = repo.queries.filter(q => q.sql.includes('FROM address') && q.sql.includes('IN'));

  assert.strictEqual(customerQueries.length, 1, 'Should use a single bulk query for customers');
  assert.strictEqual(addressQueries.length, 1, 'Should use a single bulk query for addresses');
  console.log('✅ SOAP Bulk Fetching verified.');
}

async function run() {
  try {
    await testODataBulkReferences();
    await testODataAnalyticPushdown();
    await testSoapBulkFetching();

    console.log('\\nAll tests passed!');
  } catch (e) {
    console.error('\\n❌ Verification failed:');
    console.error(e);
    process.exit(1);
  }
}

run();
