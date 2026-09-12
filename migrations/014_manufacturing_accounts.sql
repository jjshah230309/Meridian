-- =====================================================================
-- Meridian ERP :: 014_manufacturing_accounts
-- Work-in-progress and build-absorption accounts.
--
-- A build moves stock out of the warehouse before a finished good exists.
-- Without somewhere to hold that value, the issue posted nothing at all and
-- the inventory control account quietly parted company with the stock ledger.
-- These four accounts give every stage of a job a home:
--   1210 WIP                 -- components, labour and overhead, while working
--   5040 Manufacturing Variance -- what the build failed to absorb
--   5050 Direct Labour Absorbed -- the credit side of labour entering WIP
--   5060 Manufacturing Overhead Absorbed
--
-- Existing companies get them here; new ones get them from the default chart.
-- =====================================================================

INSERT INTO account (id, tenant_id, number, name, type, subtype, parent_id, currency,
                     subsidiary_id, is_summary, cash_flow_category, description, active,
                     custom, created_at, updated_at)
SELECT 'ACC' || substr(hex(randomblob(11)), 1, 22),
       t.id, v.number, v.name, v.type, v.subtype,
       (SELECT p.id FROM account p WHERE p.tenant_id = t.id AND p.number = v.parent),
       NULL, NULL, 0, v.cash_flow, '', 1, '{}',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM tenant t
CROSS JOIN (
  SELECT '1210' number, 'Work in Progress' name, 'ASSET' type, 'WIP' subtype,
         '1000' parent, 'operating' cash_flow
  UNION ALL SELECT '5040', 'Manufacturing Variance', 'EXPENSE', 'COGS', '5000', ''
  UNION ALL SELECT '5050', 'Direct Labour Absorbed', 'EXPENSE', 'COGS', '5000', ''
  UNION ALL SELECT '5060', 'Manufacturing Overhead Absorbed', 'EXPENSE', 'COGS', '5000', ''
  UNION ALL SELECT '5070', 'Purchase Price Variance', 'EXPENSE', 'COGS', '5000', ''
) v
WHERE NOT EXISTS (
  SELECT 1 FROM account a WHERE a.tenant_id = t.id AND a.number = v.number
);

-- Point existing work orders at them, so a job started before this migration
-- posts the same way as one started after it.
UPDATE work_order SET wip_account_id = (
  SELECT a.id FROM account a WHERE a.tenant_id = work_order.tenant_id AND a.number = '1210')
WHERE wip_account_id IS NULL;

UPDATE work_order SET variance_account_id = (
  SELECT a.id FROM account a WHERE a.tenant_id = work_order.tenant_id AND a.number = '5040')
WHERE variance_account_id IS NULL;
