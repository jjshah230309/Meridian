// Meridian ERP :: modules/commerce
// Marketing campaigns, partners and commission, and the sales channels that
// online and B2B orders arrive through.
//
// Attribution is computed, never typed. A campaign's revenue is the sum of
// invoices whose originating opportunity or order carries its id -- so the
// number moves when the business moves, and nobody has to remember to
// update a spreadsheet after a deal closes.
import { ulid, Money, Qty, nowIso, today, sum } from '../core/util.mjs';
import { ValidationError, notFound, unprocessable } from '../core/http.mjs';
import { nextNumber } from '../core/seq.mjs';
import * as txnMod from './txn.mjs';
import * as audit from '../core/audit.mjs';

// ------------------------------------------------------------- campaigns
export const getCampaign = (repo, id) => {
  const c = repo.get('campaign', id);
  if (!c) throw notFound(`Campaign ${id} not found`);
  return c;
};

export function createCampaign(repo, input) {
  if (!input.name) throw new ValidationError({ name: 'Name is required' });
  const now = nowIso();
  const id = ulid();
  repo.insert('campaign', {
    id, campaign_no: input.campaign_no || nextNumber(repo, 'campaign'),
    name: input.name, channel: input.channel || 'email',
    status: input.status || 'planned',
    start_date: input.start_date || null, end_date: input.end_date || null,
    budget: Money.parse(input.budget), actual_cost: Money.parse(input.actual_cost),
    target_audience: input.target_audience || '', owner_id: input.owner_id || null,
    leads_generated: 0, opportunities: 0, revenue: 0,
    custom: input.custom || {}, created_at: now, updated_at: now,
  });
  audit.record(repo, { recordType: 'campaign', recordId: id, action: 'create' });
  return getCampaign(repo, id);
}

/** Recompute a campaign's attributed results from the records that point at it. */
export function recalcCampaign(repo, id) {
  const campaign = getCampaign(repo, id);
  const leads = repo.queryOne('SELECT COUNT(*) AS c FROM lead WHERE tenant_id = :t AND campaign_id = ?', [id]);
  const opps = repo.queryOne('SELECT COUNT(*) AS c, COALESCE(SUM(amount), 0) AS pipeline FROM opportunity WHERE tenant_id = :t AND campaign_id = ?', [id]);
  const revenue = repo.queryOne(
    `SELECT COALESCE(SUM(CASE WHEN type = 'INVOICE' THEN total ELSE -total END), 0) AS revenue
     FROM txn WHERE tenant_id = :t AND campaign_id = ? AND type IN ('INVOICE','CREDIT_MEMO') AND status != 'voided'`, [id]);
  repo.update('campaign', id, {
    leads_generated: leads.c, opportunities: opps.c, revenue: revenue.revenue || 0, updated_at: nowIso(),
  });
  const cost = campaign.actual_cost || campaign.budget || 0;
  return {
    campaign: getCampaign(repo, id),
    leads: leads.c, opportunities: opps.c,
    pipeline: Money.toNumber(opps.pipeline || 0),
    revenue: Money.toNumber(revenue.revenue || 0),
    cost: Money.toNumber(cost),
    roi_pct: cost ? Math.round((((revenue.revenue || 0) - cost) / cost) * 1000) / 10 : null,
    cost_per_lead: leads.c ? Money.toNumber(Math.round(cost / leads.c)) : null,
  };
}

export const campaignPerformance = (repo) =>
  repo.query('SELECT id FROM campaign WHERE tenant_id = :t ORDER BY start_date DESC')
    .map((c) => recalcCampaign(repo, c.id));

// -------------------------------------------------------------- partners
export const getPartner = (repo, id) => {
  const p = repo.get('partner', id);
  if (!p) throw notFound(`Partner ${id} not found`);
  return p;
};

export function createPartner(repo, input) {
  if (!input.name) throw new ValidationError({ name: 'Name is required' });
  const now = nowIso();
  const id = ulid();
  repo.insert('partner', {
    id, partner_no: input.partner_no || nextNumber(repo, 'partner'),
    name: input.name, partner_type: input.partner_type || 'reseller',
    tier: input.tier || 'standard', status: input.status || 'active',
    email: input.email || '', phone: input.phone || '', website: input.website || '',
    address: input.address || {}, manager_id: input.manager_id || null,
    commission_pct: Number(input.commission_pct || 0),
    vendor_id: input.vendor_id || null,
    custom: input.custom || {}, created_at: now, updated_at: now,
  });
  return getPartner(repo, id);
}

/**
 * Accrue commission on an invoice for whoever is credited with it.
 * Commission is accrued on the invoice rather than on payment, matching the
 * revenue it relates to; clawback on a credit memo is a reversal row so both
 * sides stay visible.
 */
export function accrueCommission(repo, txnId) {
  const txn = repo.get('txn', txnId);
  if (!txn) throw notFound(`Transaction ${txnId} not found`);
  if (!['INVOICE', 'CREDIT_MEMO'].includes(txn.type)) {
    throw unprocessable('Commission is accrued against invoices and credit memos only');
  }
  if (repo.queryOne("SELECT id FROM commission WHERE tenant_id = :t AND txn_id = ? AND status != 'reversed'", [txnId])) {
    throw unprocessable(`Commission has already been accrued on ${txn.txn_no}`);
  }

  const partner = txn.partner_id ? repo.get('partner', txn.partner_id) : null;
  const rep = txn.sales_rep_id ? repo.get('employee', txn.sales_rep_id) : null;
  if (!partner && !rep) throw unprocessable(`${txn.txn_no} has neither a partner nor a sales rep, so there is nothing to commission`);

  const sign = txn.type === 'CREDIT_MEMO' ? -1 : 1;
  const basis = sign * (txn.subtotal ?? txn.total ?? 0);
  const rows = [];
  const add = (who, pct) => {
    if (!pct) return;
    const id = ulid();
    repo.insert('commission', {
      id, partner_id: who.partner_id || null, employee_id: who.employee_id || null,
      txn_id: txnId, basis_amount: basis, rate_pct: pct,
      amount: Money.pct(basis, pct), status: 'accrued',
      period_id: txn.period_id || null, paid_txn_id: null, created_at: nowIso(),
    });
    rows.push(repo.get('commission', id));
  };
  if (partner) add({ partner_id: partner.id }, partner.commission_pct);
  if (rep) add({ employee_id: rep.id }, Number(rep.commission_pct || 0));
  return { txn_no: txn.txn_no, basis: Money.toNumber(basis), commissions: rows };
}

export function commissionStatement(repo, { partner_id = null, employee_id = null, status = null } = {}) {
  const rows = repo.query(
    `SELECT cm.*, t.txn_no, t.txn_date, p.name AS partner_name, (e.first_name || ' ' || e.last_name) AS employee_name
     FROM commission cm
     JOIN txn t ON t.tenant_id = cm.tenant_id AND t.id = cm.txn_id
     LEFT JOIN partner p ON p.tenant_id = cm.tenant_id AND p.id = cm.partner_id
     LEFT JOIN employee e ON e.tenant_id = cm.tenant_id AND e.id = cm.employee_id
     WHERE cm.tenant_id = :t
       ${partner_id ? 'AND cm.partner_id = ?' : ''}
       ${employee_id ? 'AND cm.employee_id = ?' : ''}
       ${status ? 'AND cm.status = ?' : ''}
     ORDER BY t.txn_date DESC`,
    [...(partner_id ? [partner_id] : []), ...(employee_id ? [employee_id] : []), ...(status ? [status] : [])]);
  return {
    rows: rows.map((r) => ({
      id: r.id, txn_no: r.txn_no, date: r.txn_date,
      who: r.partner_name || r.employee_name,
      basis: Money.toNumber(r.basis_amount), rate_pct: r.rate_pct,
      amount: Money.toNumber(r.amount), status: r.status,
    })),
    total: Money.toNumber(sum(rows, (r) => r.amount)),
    by_status: ['accrued', 'approved', 'paid', 'reversed'].map((s) => ({
      status: s, amount: Money.toNumber(sum(rows.filter((r) => r.status === s), (r) => r.amount)),
    })),
  };
}

// -------------------------------------------------------------- channels
export function createChannel(repo, input) {
  if (!input.name) throw new ValidationError({ name: 'Name is required' });
  const id = ulid();
  repo.insert('sales_channel', {
    id, name: input.name, channel_type: input.channel_type || 'web',
    subsidiary_id: input.subsidiary_id || null, currency: input.currency || 'USD',
    price_level_id: input.price_level_id || null, location_id: input.location_id || null,
    customer_group: input.customer_group || '', active: input.active === false ? 0 : 1,
    settings: input.settings || {}, created_at: nowIso(),
  });
  return repo.get('sales_channel', id);
}

/** Publish items to a channel, defaulting price from the channel's price level. */
export function publishListings(repo, channelId, itemIds = []) {
  const channel = repo.get('sales_channel', channelId);
  if (!channel) throw notFound(`Channel ${channelId} not found`);
  let published = 0;
  for (const itemId of itemIds) {
    const item = repo.get('item', itemId);
    if (!item) continue;
    const levelPrice = channel.price_level_id
      ? repo.queryOne('SELECT price FROM item_price WHERE tenant_id = :t AND item_id = ? AND price_level_id = ?', [itemId, channel.price_level_id])
      : null;
    const existing = repo.queryOne('SELECT id FROM channel_listing WHERE tenant_id = :t AND channel_id = ? AND item_id = ?', [channelId, itemId]);
    const values = {
      channel_id: channelId, item_id: itemId,
      title: item.name, description: item.description || '',
      price: levelPrice?.price ?? item.base_price ?? 0,
      compare_price: 0, published: 1, stock_policy: 'track',
      seo_slug: String(item.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      media: [],
    };
    if (existing) repo.update('channel_listing', existing.id, { published: 1, price: values.price });
    else repo.insert('channel_listing', { id: ulid(), ...values });
    published++;
  }
  return { channel: channel.name, published };
}

/** Turn a cart into a sales order on the channel's terms. */
export function convertCart(repo, cartId, { customer_id = null, txn_date = today() } = {}) {
  const cart = repo.get('cart', cartId);
  if (!cart) throw notFound(`Cart ${cartId} not found`);
  if (cart.status === 'converted') throw unprocessable('That cart has already been converted');
  const lines = Array.isArray(cart.lines) ? cart.lines : [];
  if (!lines.length) throw unprocessable('That cart is empty');

  const channel = repo.get('sales_channel', cart.channel_id);
  const customer = customer_id || cart.customer_id;
  if (!customer) throw new ValidationError({ customer_id: 'A customer is required to convert a cart' });

  return repo.tx(() => {
    const order = txnMod.createTxn(repo, 'SALES_ORDER', {
      entity_id: customer,
      subsidiary_id: channel?.subsidiary_id || undefined,
      location_id: channel?.location_id || undefined,
      price_level_id: channel?.price_level_id || undefined,
      currency: cart.currency, txn_date,
      channel_id: cart.channel_id,
      memo: `Online order from ${channel?.name || 'web'}`,
      // Cart lines store the price the shopper was shown as `unit_price`;
      // honour it, because re-pricing a converted cart off the price list is
      // how a customer ends up billed more than the checkout page promised.
      lines: lines.map((l) => ({
        item_id: l.item_id, quantity: l.quantity,
        rate: l.unit_price ?? l.price ?? undefined,
        description: l.description || l.name || undefined,
      })),
    });
    repo.update('cart', cartId, { status: 'converted', converted_txn_id: order.id, updated_at: nowIso() });
    return { cart_id: cartId, order };
  });
}

/** Channel performance, plus the abandoned carts worth chasing. */
export function channelSummary(repo, { days = 30 } = {}) {
  const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const channels = repo.query('SELECT * FROM sales_channel WHERE tenant_id = :t AND active = 1 ORDER BY name');
  return channels.map((c) => {
    const orders = repo.queryOne(
      `SELECT COUNT(*) AS orders, COALESCE(SUM(total), 0) AS revenue
       FROM txn WHERE tenant_id = :t AND channel_id = ? AND type = 'SALES_ORDER'
         AND status != 'voided' AND txn_date >= ?`, [c.id, from]);
    const carts = repo.queryOne(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'abandoned' THEN 1 ELSE 0 END) AS abandoned,
              COALESCE(SUM(CASE WHEN status = 'abandoned' THEN subtotal ELSE 0 END), 0) AS abandoned_value
       FROM cart WHERE tenant_id = :t AND channel_id = ? AND created_at >= ?`, [c.id, from]);
    return {
      channel_id: c.id, name: c.name, type: c.channel_type,
      orders: orders.orders, revenue: Money.toNumber(orders.revenue),
      average_order: orders.orders ? Money.toNumber(Math.round(orders.revenue / orders.orders)) : 0,
      carts: carts.total, abandoned: carts.abandoned || 0,
      abandoned_value: Money.toNumber(carts.abandoned_value || 0),
      conversion_pct: carts.total ? Math.round((orders.orders / carts.total) * 1000) / 10 : null,
    };
  });
}
