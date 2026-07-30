-- Weekly auto re-audit schema additions.
-- Run manually in Neon. Every statement is idempotent and safe to re-run.

-- Tag each audit row with its origin. Existing rows predate this and are
-- treated as manual audits (the ones that consume the monthly quota).
alter table audits
  add column if not exists source text not null default 'manual';

-- Persisted diff between a new audit and the previous one for the same shop.
-- notified_at stays NULL until the future email module (session 2) picks it up.
create table if not exists audit_diffs (
  id uuid primary key default gen_random_uuid(),
  shop text not null,
  audit_id uuid not null,
  previous_audit_id uuid,
  new_issues jsonb not null default '[]'::jsonb,
  resolved_issues jsonb not null default '[]'::jsonb,
  unchanged_count int not null default 0,
  created_at timestamptz not null default now(),
  notified_at timestamptz
);

create index if not exists audit_diffs_shop_created_idx
  on audit_diffs (shop, created_at desc);

-- Last time the weekly cron ran an automatic re-audit for this shop. Written
-- before the audit starts so a failing shop is not retried every day forever.
alter table shops
  add column if not exists last_auto_audit_at timestamptz;

create index if not exists audits_shop_created_idx
  on audits (shop, created_at desc);
