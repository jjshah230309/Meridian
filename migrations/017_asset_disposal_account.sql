-- =====================================================================
-- Meridian ERP :: 017_asset_disposal_account
-- Somewhere for a gain or a loss on selling an asset to land.
--
-- disposeAsset fell back to the first OTHER_INCOME account it could find,
-- which in the default chart is 4950 Shipping Income -- so selling a van at a
-- profit read as freight revenue, and selling it at a loss read as negative
-- freight revenue. The asset class already carries a "Gain / loss on
-- disposal" field, which nothing read.
-- =====================================================================

INSERT INTO account (id, tenant_id, number, name, type, subtype, parent_id, currency,
                     subsidiary_id, is_summary, cash_flow_category, description, active,
                     custom, created_at, updated_at)
SELECT 'ACC' || substr(hex(randomblob(11)), 1, 22),
       t.id, '7050', 'Gain / Loss on Asset Disposal', 'EXPENSE', 'OTHER_EXPENSE',
       (SELECT p.id FROM account p WHERE p.tenant_id = t.id AND p.number = '7000'),
       NULL, NULL, 0, '', '', 1, '{}',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM tenant t
WHERE NOT EXISTS (
  SELECT 1 FROM account a WHERE a.tenant_id = t.id AND a.number = '7050'
);

-- Asset classes that never had a disposal account named get the new one.
UPDATE asset_class SET disposal_account_id = (
  SELECT a.id FROM account a WHERE a.tenant_id = asset_class.tenant_id AND a.number = '7050')
WHERE disposal_account_id IS NULL;
