-- One-time purchase expiry: 149 CHF grants full access for 30 days.
-- Run manually in Neon. Idempotent and safe to re-run.

-- When the one-time "Mise en conformite" charge became active. Full access is
-- granted while one_time_status = 'active' AND this timestamp is under 30 days
-- old. Written by the billing return flow (syncBillingState -> writeSyncedState)
-- the first time the charge is seen active.
alter table billing_state
  add column if not exists one_time_purchased_at timestamptz;

-- Backfill existing active one-time purchases so they are not treated as
-- never-purchased. updated_at approximates the activation moment for rows that
-- predate this column.
update billing_state
  set one_time_purchased_at = coalesce(one_time_purchased_at, updated_at)
  where one_time_status = 'active'
    and one_time_purchased_at is null;
