import { neon } from "@neondatabase/serverless";
import type { AuditIssue } from "./auditDiff";

function db() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Missing DATABASE_URL env var");
  return neon(url);
}

// Self-healing schema for the auto re-audit feature. Mirrors migrations/
// auto_reaudit.sql so the code works even if the manual migration has not run
// yet, following the existing ensureSchema pattern in this repo. Every
// statement is idempotent.
let ready = false;
async function ensureSchema(): Promise<void> {
  if (ready) return;
  const sql = db();
  await sql`alter table shops add column if not exists last_auto_audit_at timestamptz`;
  await sql`
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
    )
  `;
  await sql`
    create index if not exists audit_diffs_shop_created_idx
      on audit_diffs (shop, created_at desc)
  `;
  ready = true;
}

export type ReauditCandidate = {
  shop: string;
  user_id: string;
  last_auto_audit_at: string | null;
};

// Shops eligible for an automatic weekly re-audit: an active Shopify Billing
// subscription (or active one-time charge) on the shop, a known owner, and no
// auto audit in the last 7 days. Oldest first (NULLs first) so never-audited
// shops are picked up before recently done ones. Limited to `limit` per run;
// the daily cron catches up the rest.
export async function selectShopsDueForReaudit(
  limit: number,
): Promise<ReauditCandidate[]> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql`
    select s.shop, s.user_id, s.last_auto_audit_at
    from shops s
    join billing_state b on b.shop = s.shop
    where s.user_id is not null
      and (b.subscription_status = 'active' or b.one_time_status = 'active')
      and (
        s.last_auto_audit_at is null
        or s.last_auto_audit_at < now() - interval '7 days'
      )
    order by s.last_auto_audit_at asc nulls first
    limit ${limit}
  `) as ReauditCandidate[];
  return rows;
}

// Stamp the shop as auto-audited now. Called BEFORE the audit runs so a shop
// that fails is not retried on every daily run; the next attempt waits 7 days.
export async function touchLastAutoAudit(shop: string): Promise<void> {
  await ensureSchema();
  const sql = db();
  await sql`update shops set last_auto_audit_at = now() where shop = ${shop}`;
}

// Persist the diff between the new audit and the previous one. notified_at is
// left NULL for the future email module to claim.
export async function insertAuditDiff(input: {
  shop: string;
  auditId: string;
  previousAuditId: string | null;
  newIssues: AuditIssue[];
  resolvedIssues: AuditIssue[];
  unchangedCount: number;
}): Promise<string> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql`
    insert into audit_diffs (
      shop, audit_id, previous_audit_id,
      new_issues, resolved_issues, unchanged_count
    )
    values (
      ${input.shop}, ${input.auditId}, ${input.previousAuditId},
      ${JSON.stringify(input.newIssues)}, ${JSON.stringify(input.resolvedIssues)},
      ${input.unchangedCount}
    )
    returning id
  `) as { id: string }[];
  return rows[0].id;
}
