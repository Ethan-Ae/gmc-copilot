-- Async audit worker: queue/running lifecycle, progress reporting, and
-- persisted model/truncation/GMC-connection metadata.
-- Run manually in Neon. Every statement is idempotent and safe to re-run.

alter table audits add column if not exists progress_step text;
alter table audits add column if not exists error_message text;
alter table audits add column if not exists model text;
alter table audits add column if not exists truncated boolean not null default false;
alter table audits add column if not exists gmc_connected boolean not null default false;
alter table audits add column if not exists field_snapshots jsonb;
