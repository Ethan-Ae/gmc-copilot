-- Shopify App Store installs complete OAuth before the merchant has an account
-- here, so a shop row can exist with no owner until they sign up and
-- /api/shopify/claim attaches it.
-- Run manually in Neon. Idempotent and safe to re-run.

-- shops.user_id was added by lib/db.ts ensureSchema() as a plain nullable
-- column, so this is a no-op on the current schema. It is stated explicitly so
-- the orphan-then-claim flow cannot be broken by a later NOT NULL being added.
alter table shops
  alter column user_id drop not null;

-- /api/shopify/claim looks a shop up by primary key, but the dashboard and the
-- audit paths filter by owner, and orphan rows are worth finding cheaply when
-- diagnosing an install that never got claimed.
create index if not exists shops_user_id_idx
  on shops (user_id);
