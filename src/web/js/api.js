// Meridian ERP :: web/api
// Fetch wrapper: attaches the CSRF token, normalises errors into something
// the UI can show next to a field, and surfaces a global loading indicator.

let csrfToken = null;
const listeners = new Set();
let inflight = 0;

export const setCsrf = (t) => { csrfToken = t; };
export const onLoading = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
function tick(delta) {
  inflight = Math.max(0, inflight + delta);
  listeners.forEach((fn) => fn(inflight > 0));
}

/** Error carrying field-level detail, so forms can highlight inputs. */
export class ApiError extends Error {
  constructor(status, payload) {
    super(payload?.error?.message || `Request failed (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.code = payload?.error?.code || 'ERROR';
    this.fields = payload?.error?.fields || payload?.error?.details?.fields || null;
    this.requestId = payload?.error?.requestId || null;
  }
}

async function request(method, path, body, opts = {}) {
  tick(1);
  try {
    const headers = { Accept: 'application/json' };
    if (body !== undefined && body !== null) headers['Content-Type'] = 'application/json';
    if (csrfToken && method !== 'GET') headers['X-CSRF-Token'] = csrfToken;
    const res = await fetch(path, {
      method, headers, credentials: 'same-origin',
      body: body === undefined || body === null ? undefined : JSON.stringify(body),
      signal: opts.signal,
    });
    if (res.status === 204) return null;

    const type = res.headers.get('content-type') || '';
    if (!type.includes('application/json')) {
      const text = await res.text();
      if (!res.ok) throw new ApiError(res.status, { error: { message: text.slice(0, 300) } });
      return text;
    }
    const payload = await res.json();
    if (!res.ok) {
      if (res.status === 401 && !opts.allowUnauthorised) window.dispatchEvent(new CustomEvent('meridian:signed-out'));
      throw new ApiError(res.status, payload);
    }
    return payload;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (e.name === 'AbortError') throw e;
    throw new ApiError(0, { error: { message: 'Could not reach the Meridian service. Is it still running?' } });
  } finally { tick(-1); }
}

export const get = (path, params) => {
  const qs = params ? '?' + new URLSearchParams(Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)])).toString() : '';
  return request('GET', path + qs);
};
export const post = (path, body) => request('POST', path, body ?? {});
export const patch = (path, body) => request('PATCH', path, body ?? {});
export const put = (path, body) => request('PUT', path, body ?? {});
export const del = (path, body) => request('DELETE', path, body ?? {});

/** Trigger a CSV download through a blob so the CSP stays intact. */
export async function download(path, params) {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  const res = await fetch(path + qs, { credentials: 'same-origin' });
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => ({})));
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || 'export.csv';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ------------------------------------------------------- domain calls
export const API = {
  session: () => get('/api/v1/auth/session'),
  login: (email, password, tenant) => request('POST', '/api/v1/auth/login', { email, password, tenant }, { allowUnauthorised: true }),
  logout: () => post('/api/v1/auth/logout'),
  tenants: () => request('GET', '/api/v1/auth/tenants', undefined, { allowUnauthorised: true }),
  setupState: () => request('GET', '/api/v1/setup/state', undefined, { allowUnauthorised: true }),
  provision: (body) => request('POST', '/api/v1/setup/provision', body, { allowUnauthorised: true }),
  changePassword: (current_password, new_password) => post('/api/v1/auth/password', { current_password, new_password }),

  meta: () => get('/api/v1/meta'),
  list: (type, params) => get(`/api/v1/records/${type}`, params),
  record: (type, id) => get(`/api/v1/records/${type}/${id}`),
  create: (type, body) => post(`/api/v1/records/${type}`, body),
  update: (type, id, body) => patch(`/api/v1/records/${type}/${id}`, body),
  remove: (type, id, body) => del(`/api/v1/records/${type}/${id}`, body),
  search: (record_type, definition, limit, offset) => post('/api/v1/search', { record_type, definition, limit, offset }),
  globalSearch: (q) => get('/api/v1/search/global', { q }),
  savedSearches: () => get('/api/v1/saved-searches'),

  chart: (params) => get('/api/v1/gl/accounts', params),
  journal: (id) => get(`/api/v1/gl/journal/${id}`),
  postJournal: (body) => post('/api/v1/gl/journal', body),
  reverseJournal: (id, body) => post(`/api/v1/gl/journal/${id}/reverse`, body),
  ledger: (accountId, params) => get(`/api/v1/gl/ledger/${accountId}`, params),
  periods: () => get('/api/v1/gl/periods'),
  closePeriod: (id, force) => post(`/api/v1/gl/periods/${id}/close`, { force }),
  reopenPeriod: (id) => post(`/api/v1/gl/periods/${id}/reopen`),
  generatePeriods: (fiscal_year) => post('/api/v1/gl/periods/generate', { fiscal_year }),
  rates: () => get('/api/v1/gl/rates'),
  addRate: (body) => post('/api/v1/gl/rates', body),

  txns: (params) => get('/api/v1/txn', params),
  txn: (id) => get(`/api/v1/txn/${id}`),
  approve: (id, body) => post(`/api/v1/txn/${id}/approve`, body),
  reject: (id, body) => post(`/api/v1/txn/${id}/reject`, body),
  voidTxn: (id, body) => post(`/api/v1/txn/${id}/void`, body),
  transformPreview: (id, target) => get(`/api/v1/txn/${id}/transform/${target}`),
  transform: (id, target, body) => post(`/api/v1/txn/${id}/transform/${target}`, body),
  payment: (body) => post('/api/v1/payments', body),
  unapply: (id, txn_id) => post(`/api/v1/payments/${id}/unapply`, { txn_id }),
  openDocuments: (entityType, id) => get(`/api/v1/entities/${entityType}/${id}/open-documents`),
  priceQuote: (body) => post('/api/v1/pricing/quote', body),

  availability: (itemId) => get(`/api/v1/inventory/availability/${itemId}`),
  reorder: (params) => get('/api/v1/inventory/reorder', params),
  valuation: (params) => get('/api/v1/inventory/valuation', params),
  setLevels: (body) => post('/api/v1/inventory/levels', body),
  createReorderPos: (suggestions) => post('/api/v1/inventory/reorder/create-pos', { suggestions }),

  pipeline: (params) => get('/api/v1/crm/pipeline', params),
  forecast: (params) => get('/api/v1/crm/forecast', params),
  convertLead: (id, body) => post(`/api/v1/crm/leads/${id}/convert`, body),
  supportMetrics: () => get('/api/v1/crm/support/metrics'),
  caseMessage: (id, body) => post(`/api/v1/crm/cases/${id}/messages`, body),

  directory: (params) => get('/api/v1/hr/directory', params),
  orgChart: () => get('/api/v1/hr/orgchart'),
  timesheet: (employeeId, week_start) => get(`/api/v1/hr/timesheet/${employeeId}`, { week_start }),
  approveTime: (ids, approve) => post('/api/v1/hr/time/approve', { ids, approve }),
  decideTimeOff: (id, approve) => post(`/api/v1/hr/timeoff/${id}/decide`, { approve }),
  calcPayroll: (body) => post('/api/v1/hr/payroll/calculate', body),
  payrollRun: (id) => get(`/api/v1/hr/payroll/${id}`),
  approvePayroll: (id) => post(`/api/v1/hr/payroll/${id}/approve`),
  exportPayroll: (id, body) => post(`/api/v1/hr/payroll/${id}/export`, body),

  dashboard: (params) => get('/api/v1/reports/dashboard', params),
  report: (name, params) => get(`/api/v1/reports/${name}`, params),
  drilldown: (metric) => get(`/api/v1/reports/drilldown/${metric}`),

  bankAccounts: () => get('/api/v1/bank/accounts'),
  bankTxns: (id, params) => get(`/api/v1/bank/${id}/transactions`, params),
  importStatement: (id, body) => post(`/api/v1/bank/${id}/import`, body),
  suggestMatches: (id) => get(`/api/v1/bank/${id}/suggest`),
  autoMatch: (id) => post(`/api/v1/bank/${id}/auto-match`),
  match: (bank_txn_id, journal_entry_id) => post('/api/v1/bank/match', { bank_txn_id, journal_entry_id }),
  unmatch: (bank_txn_id) => post('/api/v1/bank/unmatch', { bank_txn_id }),
  startRec: (body) => post('/api/v1/bank/reconciliations', body),
  recState: (id) => get(`/api/v1/bank/reconciliations/${id}`),
  recSelect: (id, ids) => post(`/api/v1/bank/reconciliations/${id}/select`, { ids }),
  recComplete: (id, force) => post(`/api/v1/bank/reconciliations/${id}/complete`, { force }),

  audit: (params) => get('/api/v1/audit', params),
  notifications: (params) => get('/api/v1/notifications', params),
  markRead: (id) => post('/api/v1/notifications/read', { id }),
  testWorkflow: (id, record_id) => post(`/api/v1/workflows/${id}/test`, { record_id }),

  expenseAction: (id, action, body) => post(`/api/v1/expense-reports/${id}/${action}`, body || {}),
  validateExpression: (expression, scope) => post('/api/v1/expressions/validate', { expression, scope }),

  dashboardLayout: () => get('/api/v1/dashboards'),
  saveDashboard: (layout) => put('/api/v1/dashboards', { layout }),

  roles: () => get('/api/v1/setup/roles'),
  saveRolePermissions: (id, permissions) => put(`/api/v1/setup/roles/${id}/permissions`, { permissions }),
  users: () => get('/api/v1/setup/users'),
  createUser: (body) => post('/api/v1/setup/users', body),
  setUserRoles: (id, role_ids) => put(`/api/v1/setup/users/${id}/roles`, { role_ids }),
  company: () => get('/api/v1/setup/company'),
  integrationEvents: () => get('/api/v1/setup/integration-events'),
  // ---- projects, production, warehouse and field service
  projectPortfolio: (status) => get('/api/v1/projects/portfolio', status ? { status } : undefined),
  projectUtilisation: (params) => get('/api/v1/projects/utilisation', params),
  projectTasks: (id) => get(`/api/v1/projects/${id}/tasks`),
  projectProfitability: (id) => get(`/api/v1/projects/${id}/profitability`),
  projectUnbilled: (id) => get(`/api/v1/projects/${id}/unbilled`),
  billProject: (id, body) => post(`/api/v1/projects/${id}/bill`, body ?? {}),
  releaseWorkOrder: (id) => post(`/api/v1/work-orders/${id}/release`),
  issueWorkOrder: (id, body) => post(`/api/v1/work-orders/${id}/issue`, body ?? {}),
  buildWorkOrder: (id, quantity) => post(`/api/v1/work-orders/${id}/build`, { quantity }),
  qualitySummary: (params) => get('/api/v1/quality/summary', params),
  warehouseWorkload: () => get('/api/v1/warehouse/workload'),
  generatePutaway: (body) => post('/api/v1/warehouse/putaway/generate', body ?? {}),
  releaseWave: (id) => post(`/api/v1/waves/${id}/release`),
  packWave: (id) => post(`/api/v1/waves/${id}/pack`),
  shipWave: (id) => post(`/api/v1/waves/${id}/ship`),
  dispatchBoard: (date) => get('/api/v1/service/dispatch', date ? { date } : undefined),
  serviceRenewals: (within_days) => get('/api/v1/service/renewals', within_days ? { within_days } : undefined),
  availableTechnicians: (start, end) => get('/api/v1/service/technicians/available', { start, end }),
  scheduleServiceOrder: (id, body) => post(`/api/v1/service/orders/${id}/schedule`, body),
  serviceOrderStatus: (id, status) => post(`/api/v1/service/orders/${id}/status`, { status }),

  // ---- revenue recognition and amortisation
  schedules: (params) => get('/api/v1/schedules', params),
  schedule: (id) => get(`/api/v1/schedules/${id}`),
  scheduleWaterfall: (params) => get('/api/v1/schedules/waterfall', params),
  schedulesDue: (params) => get('/api/v1/schedules/due', params),
  runRecognition: (body) => post('/api/v1/schedules/run', body),
  releaseSchedule: (id, body) => post(`/api/v1/schedules/${id}/release`, body ?? {}),

  // ---- recurring journals and accruals
  recurringList: (params) => get('/api/v1/recurring', params),
  recurring: (id) => get(`/api/v1/recurring/${id}`),
  recurringDue: (params) => get('/api/v1/recurring/due', params),
  createRecurring: (body) => post('/api/v1/recurring', body),
  updateRecurring: (id, body) => put(`/api/v1/recurring/${id}`, body),
  recurringStatus: (id, status) => post(`/api/v1/recurring/${id}/status`, { status }),
  runRecurring: (body) => post('/api/v1/recurring/run', body),

  // ---- foreign currency revaluation
  fxExposures: (params) => get('/api/v1/revaluation/exposures', params),
  fxRuns: (params) => get('/api/v1/revaluation/runs', params),
  fxRun: (id) => get(`/api/v1/revaluation/runs/${id}`),
  runFxRevaluation: (body) => post('/api/v1/revaluation/run', body),
  reverseFxRun: (id, body) => post(`/api/v1/revaluation/runs/${id}/reverse`, body ?? {}),

  // ---- collections
  collectionsWorklist: (params) => get('/api/v1/collections/worklist', params),
  customerStatement: (id, params) => get(`/api/v1/collections/statement/${id}`, params),
  statementPdf: (id, params) => download(`/api/v1/collections/statement/${id}/pdf`, params),
  updateCollectionState: (id, body) => post(`/api/v1/collections/customers/${id}`, body),
  dunningPolicies: () => get('/api/v1/collections/policies'),
  dunningPolicy: (id) => get(`/api/v1/collections/policies/${id}`),
  saveDunningPolicy: (id, body) => (id ? put(`/api/v1/collections/policies/${id}`, body) : post('/api/v1/collections/policies', body)),
  dunningCandidates: (params) => get('/api/v1/collections/dunning/candidates', params),
  runDunning: (body) => post('/api/v1/collections/dunning/run', body ?? {}),
  dunningNotices: (params) => get('/api/v1/collections/notices', params),
  dunningNotice: (id) => get(`/api/v1/collections/notices/${id}`),
  noticePdf: (id) => download(`/api/v1/collections/notices/${id}/pdf`),
  cancelNotice: (id, body) => post(`/api/v1/collections/notices/${id}/cancel`, body ?? {}),
  writeOff: (txnId, body) => post(`/api/v1/collections/write-off/${txnId}`, body),
  runAllowance: (body) => post('/api/v1/collections/allowance', body ?? {}),

  // ---- paying the suppliers
  paymentRuns: (params) => get('/api/v1/payment-runs', params),
  paymentRun: (id) => get(`/api/v1/payment-runs/${id}`),
  createPaymentRun: (body) => post('/api/v1/payment-runs', body),
  updatePaymentRunLines: (id, lines) => put(`/api/v1/payment-runs/${id}/lines`, { lines }),
  payPaymentRun: (id, body) => post(`/api/v1/payment-runs/${id}/pay`, body ?? {}),
  cancelPaymentRun: (id, body) => post(`/api/v1/payment-runs/${id}/cancel`, body ?? {}),
  remittancePdf: (id, vendorId) => download(`/api/v1/payment-runs/${id}/remittance/${vendorId}`),
  paymentFileCsv: (id) => download(`/api/v1/payment-runs/${id}/file`),

  // ---- tax returns and 1099s
  taxReturns: (params) => get('/api/v1/tax/returns', params),
  taxReturnPreview: (params) => get('/api/v1/tax/returns/preview', params),
  taxReturn: (id) => get(`/api/v1/tax/returns/${id}`),
  taxReturnPdf: (id) => download(`/api/v1/tax/returns/${id}/pdf`),
  fileTaxReturn: (body) => post('/api/v1/tax/returns', body),
  unfileTaxReturn: (id, body) => post(`/api/v1/tax/returns/${id}/unfile`, body ?? {}),
  report1099: (params) => get('/api/v1/tax/1099', params),
  export1099: (year, format = 'csv') => download('/api/v1/tax/1099/export', { year, format }),

  // ---- data interchange
  importTypes: () => get('/api/v1/import/record-types'),
  importSuggest: (type, text) => post(`/api/v1/import/${type}/suggest`, { text }),
  importValidate: (type, body) => post(`/api/v1/import/${type}/validate`, body),
  importCommit: (type, body) => post(`/api/v1/import/${type}/commit`, body),
  importTemplate: (type, format = 'csv') => download(`/api/v1/import/${type}/template`, { format }),
  importJobs: () => get('/api/v1/import/jobs'),
  reverseImport: (id) => post(`/api/v1/import/jobs/${id}/reverse`),
  statementFormats: () => get('/api/v1/bank/statement-formats'),
  previewStatement: (text) => post('/api/v1/bank/statements/preview', { text }),
  importStatementFile: (body) => post('/api/v1/bank/statements/import', body),
  exportPack: (format = 'xlsx') => download('/api/v1/export/reports/pack', { format }),
  powerBiConnection: () => get('/api/v1/powerbi/connection'),
  powerBiFile: () => download('/api/v1/powerbi/meridian.pbids'),
  // ---- subscriptions
  subscriptions: (params) => get('/api/v1/subscriptions', params),
  subscription: (id) => get(`/api/v1/subscriptions/${id}`),
  previewSubscription: (id, params) => get(`/api/v1/subscriptions/${id}/preview`, params),
  createSubscription: (body) => post('/api/v1/subscriptions', body),
  updateSubscription: (id, body) => put(`/api/v1/subscriptions/${id}`, body),
  activateSubscription: (id) => post(`/api/v1/subscriptions/${id}/activate`),
  suspendSubscription: (id, body) => post(`/api/v1/subscriptions/${id}/suspend`, body ?? {}),
  resumeSubscription: (id) => post(`/api/v1/subscriptions/${id}/resume`),
  cancelSubscription: (id, body) => post(`/api/v1/subscriptions/${id}/cancel`, body ?? {}),
  amendSubscription: (id, body) => post(`/api/v1/subscriptions/${id}/amend`, body),
  recordUsage: (id, body) => post(`/api/v1/subscriptions/${id}/usage`, body),
  billSubscriptions: (body) => post('/api/v1/subscriptions/bill', body ?? {}),

  // ---- intercompany
  intercompany: (params) => get('/api/v1/intercompany', params),
  intercompanyTxn: (id) => get(`/api/v1/intercompany/${id}`),
  intercompanyJournal: (body) => post('/api/v1/intercompany/journal', body),
  intercompanySale: (body) => post('/api/v1/intercompany/sale', body),
  previewElimination: (params) => get('/api/v1/intercompany/eliminations/preview', params),
  eliminationRun: (id) => get(`/api/v1/intercompany/eliminations/${id}`),
  runElimination: (body) => post('/api/v1/intercompany/eliminations', body ?? {}),
  reverseElimination: (id, body) => post(`/api/v1/intercompany/eliminations/${id}/reverse`, body ?? {}),
  createEliminationSubsidiary: () => post('/api/v1/intercompany/elimination-subsidiary'),

  // ---- custom record types
  customRecordTypes: () => get('/api/v1/custom-records'),
  customRecordType: (name) => get(`/api/v1/custom-records/${name}`),
  createCustomRecordType: (body) => post('/api/v1/custom-records', body),
  updateCustomRecordType: (name, body) => put(`/api/v1/custom-records/${name}`, body),
  deleteCustomRecordType: (name) => del(`/api/v1/custom-records/${name}`),

  // ---- fixed assets
  assetRegister: (params) => get('/api/v1/assets/register', params),
  assetSchedule: (id) => get(`/api/v1/assets/${id}/schedule`),
  placeAssetInService: (id, body) => post(`/api/v1/assets/${id}/place-in-service`, body ?? {}),
  disposeAsset: (id, body) => post(`/api/v1/assets/${id}/dispose`, body ?? {}),
  depreciationDue: (params) => get('/api/v1/assets/depreciation/due', params),
  runDepreciation: (body) => post('/api/v1/assets/depreciation/run', body ?? {}),

  // ---- asset revaluation and transfer
  assetValue: (id) => get(`/api/v1/assets/${id}/value`),
  previewRevaluation: (id, params) => get(`/api/v1/assets/${id}/revalue/preview`, params),
  revalueAsset: (id, body) => post(`/api/v1/assets/${id}/revalue`, body),
  transferAsset: (id, body) => post(`/api/v1/assets/${id}/transfer`, body),
  revaluations: (params) => get('/api/v1/revaluations', params),
  reverseAssetRevaluation: (id, body) => post(`/api/v1/revaluations/${id}/reverse`, body ?? {}),

  // ---- accounting books
  books: (params) => get('/api/v1/books', params),
  book: (id) => get(`/api/v1/books/${id}`),
  createBook: (body) => post('/api/v1/books', body),
  updateBook: (id, body) => put(`/api/v1/books/${id}`, body),
  deleteBook: (id) => del(`/api/v1/books/${id}`),
  postBookAdjustment: (id, body) => post(`/api/v1/books/${id}/adjustments`, body),
  reverseBookAdjustment: (id, adjId, body) => post(`/api/v1/books/${id}/adjustments/${adjId}/reverse`, body ?? {}),
  setAssetBookRule: (id, body) => post(`/api/v1/books/${id}/asset-rules`, body),
  removeAssetBookRule: (id, ruleId) => del(`/api/v1/books/${id}/asset-rules/${ruleId}`),
  runBookDepreciation: (id, body) => post(`/api/v1/books/${id}/depreciation`, body ?? {}),

  // ---- cost allocation
  allocations: (params) => get('/api/v1/allocations', params),
  allocation: (id) => get(`/api/v1/allocations/${id}`),
  previewAllocation: (id, params) => get(`/api/v1/allocations/${id}/preview`, params),
  runAllocation: (id, body) => post(`/api/v1/allocations/${id}/run`, body ?? {}),
  saveAllocation: (id, body) => (id ? put(`/api/v1/allocations/${id}`, body) : post('/api/v1/allocations', body)),
  postStatistic: (body) => post('/api/v1/allocations/statistics', body),

  companySettings: () => get('/api/v1/setup/company'),
  connectionSettings: () => get('/api/v1/settings/connection'),
  saveConnectionSettings: (body) => put('/api/v1/settings/connection', body),
  apiTokens: () => get('/api/v1/setup/api-tokens'),
  createApiToken: (name, expires_at = null) => post('/api/v1/setup/api-tokens', { name, expires_at }),
  revokeApiToken: (id) => del(`/api/v1/setup/api-tokens/${id}`),

  exportCsv: (type, definition) => API.exportFile(type, 'csv', definition),
  // `format` is 'csv', 'xlsx' (a styled workbook) or 'json'. Passing the
  // current search definition exports exactly what the grid is showing.
  exportFile: (type, format = 'csv', definition = null) => download(`/api/v1/export/${type}`, {
    format, ...(definition ? { definition: JSON.stringify(definition) } : {}),
  }),
};
