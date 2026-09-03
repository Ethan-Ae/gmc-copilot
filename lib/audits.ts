import { neon } from "@neondatabase/serverless";

function db() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Missing DATABASE_URL env var");
  return neon(url);
}

let ready = false;
async function ensureSchema(): Promise<void> {
  if (ready) return;
  const sql = db();
  await sql`
    create table if not exists audits (
      id uuid primary key default gen_random_uuid(),
      user_id text,
      shop text,
      created_at timestamptz not null default now(),
      overall text,
      result jsonb
    )
  `;
  // status tracks the lifecycle: 'queued' reserved right after the request,
  // 'running' once the background worker picked it up, 'done' on success,
  // 'failed' when the call errored after being engaged. Existing rows predate
  // this and default to 'done' (legacy synchronous flow) or 'pending' (an
  // older reserved-but-unfinished name, treated the same as 'queued' below).
  await sql`alter table audits add column if not exists status text not null default 'done'`;
  // source tags the origin: 'manual' (user-triggered, counts against the
  // monthly quota) or 'auto' (weekly monitoring re-audit, quota-free).
  await sql`alter table audits add column if not exists source text not null default 'manual'`;
  // Human-readable step shown to the merchant while the async worker runs,
  // e.g. "Lecture des produits". Null once the audit is done or failed.
  await sql`alter table audits add column if not exists progress_step text`;
  // Raw failure detail, for debugging only - never sent to the client as-is.
  await sql`alter table audits add column if not exists error_message text`;
  // Fixed category used to pick the safe, French message shown to the
  // merchant (see lib/auditErrors.ts). Null on legacy rows -> "unknown".
  await sql`alter table audits add column if not exists error_code text`;
  // Claude model id and whether the tool response hit max_tokens, persisted so
  // GET /api/audits/[id] can return them without re-deriving anything.
  await sql`alter table audits add column if not exists model text`;
  await sql`alter table audits add column if not exists truncated boolean not null default false`;
  // Whether a Google Merchant Center account was connected for this audit, so
  // the report can show a single "connect GMC" banner instead of a per-issue
  // "not confirmed" tag.
  await sql`alter table audits add column if not exists gmc_connected boolean not null default false`;
  // True field values read straight from the Shopify Admin API at audit time,
  // keyed by "<targetId>|<field>" (e.g. "gid://shopify/Product/1|descriptionHtml").
  // Used as the drift baseline in /api/fix instead of the patch's currentValue,
  // which is Claude's transcription of that value and is not guaranteed to be
  // byte-exact (long HTML in particular). Updated after a successful write so a
  // second fix on the same field within the same audit compares against the
  // value we just wrote, not the stale audit-time one.
  await sql`alter table audits add column if not exists field_snapshots jsonb`;
  ready = true;
}

// Origin of an audit row. 'manual' consumes the monthly quota, 'auto' does not.
export type AuditSource = "manual" | "auto";

export type AuditStatus = "pending" | "queued" | "running" | "done" | "failed";

export type AuditRow = {
  id: string;
  user_id: string | null;
  shop: string | null;
  created_at: string;
  overall: string | null;
  result: unknown;
  status: AuditStatus;
  progress_step: string | null;
  error_message: string | null;
  error_code: string | null;
  model: string | null;
  truncated: boolean;
  gmc_connected: boolean;
  field_snapshots: Record<string, string> | null;
};

// Reserve a quota row as 'queued' right after the request is accepted, before
// any Shopify or Claude call. Returns the new row id so the caller can later
// move it to 'running', then 'done' or 'failed'. Because the row exists from
// this point on, a crash later still consumes the user's monthly quota.
export async function createQueuedAudit(
  userId: string,
  shop: string,
  source: AuditSource = "manual",
): Promise<string> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql`
    insert into audits (user_id, shop, status, source)
    values (${userId}, ${shop}, 'queued', ${source})
    returning id
  `) as { id: string }[];
  return rows[0].id;
}

// Kept for the synchronous callers (weekly cron re-audit) that still create
// and finish an audit row within a single long-running invocation.
export async function createPendingAudit(
  userId: string,
  shop: string,
  source: AuditSource = "manual",
): Promise<string> {
  return createQueuedAudit(userId, shop, source);
}

export async function markAuditRunning(
  id: string,
  step: string,
): Promise<void> {
  await ensureSchema();
  const sql = db();
  await sql`
    update audits
    set status = 'running', progress_step = ${step}
    where id = ${id}
  `;
}

export async function updateAuditProgress(
  id: string,
  step: string,
): Promise<void> {
  await ensureSchema();
  const sql = db();
  await sql`update audits set progress_step = ${step} where id = ${id}`;
}

export async function markAuditDone(
  id: string,
  overall: string,
  result: unknown,
  extra?: {
    model?: string;
    truncated?: boolean;
    gmcConnected?: boolean;
    fieldSnapshots?: Record<string, string>;
  },
): Promise<void> {
  await ensureSchema();
  const sql = db();
  await sql`
    update audits
    set status = 'done',
        overall = ${overall},
        result = ${JSON.stringify(result)},
        progress_step = null,
        error_message = null,
        model = ${extra?.model ?? null},
        truncated = ${extra?.truncated ?? false},
        gmc_connected = ${extra?.gmcConnected ?? false},
        field_snapshots = ${extra?.fieldSnapshots ? JSON.stringify(extra.fieldSnapshots) : null}
    where id = ${id}
  `;
}

// Called after a successful fix write so a later fix on the same product
// within the same audit compares drift against the value we just wrote,
// instead of the stale audit-time snapshot.
export async function updateFieldSnapshot(
  id: string,
  key: string,
  value: string,
): Promise<void> {
  await ensureSchema();
  const sql = db();
  await sql`
    update audits
    set field_snapshots = coalesce(field_snapshots, '{}'::jsonb) || jsonb_build_object(${key}::text, ${value}::text)
    where id = ${id}
  `;
}

export async function markAuditFailed(
  id: string,
  errorMessage?: string,
  errorCode?: string,
): Promise<void> {
  await ensureSchema();
  const sql = db();
  await sql`
    update audits
    set status = 'failed', progress_step = null,
        error_message = ${errorMessage ?? null},
        error_code = ${errorCode ?? null}
    where id = ${id}
  `;
}

// History only surfaces completed audits, never pending or failed attempts.
export async function getAuditsForUser(userId: string): Promise<AuditRow[]> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql`
    select id, user_id, shop, created_at, overall, result,
           status, progress_step, error_message, error_code, model, truncated, gmc_connected,
           field_snapshots
    from audits
    where user_id = ${userId} and status = 'done'
    order by created_at desc
    limit 50
  `) as AuditRow[];
  return rows;
}

// Counts every manual attempt still in flight or completed (queued, running,
// pending [legacy], done). Requests rejected upstream (401/403/402) never
// insert a row, so they are not counted. A 'failed' row is refunded: the
// Claude call did not produce a usable result, so it must not eat the
// merchant's monthly quota. Automatic monitoring re-audits (source 'auto')
// are excluded: they are included in the subscription and must not eat the
// manual quota either.
export async function countAuditsForUserSince(
  userId: string,
  sinceISO: string,
): Promise<number> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql`
    select count(*)::int as n
    from audits
    where user_id = ${userId}
      and created_at >= ${sinceISO}
      and source = 'manual'
      and status <> 'failed'
  `) as { n: number }[];
  return rows.length ? rows[0].n : 0;
}

// Latest completed audit for a shop, optionally excluding one id (the audit we
// just created), used to compute the diff against the previous run.
export async function getLatestDoneAuditForShop(
  shop: string,
  excludeId?: string,
): Promise<AuditRow | null> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql`
    select id, user_id, shop, created_at, overall, result,
           status, progress_step, error_message, error_code, model, truncated, gmc_connected,
           field_snapshots
    from audits
    where shop = ${shop}
      and status = 'done'
      and (${excludeId ?? null}::uuid is null or id <> ${excludeId ?? null}::uuid)
    order by created_at desc
    limit 1
  `) as AuditRow[];
  return rows.length ? rows[0] : null;
}

export async function getAuditById(
  id: string,
  userId: string,
): Promise<AuditRow | null> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql`
    select id, user_id, shop, created_at, overall, result,
           status, progress_step, error_message, error_code, model, truncated, gmc_connected,
           field_snapshots
    from audits
    where id = ${id} and user_id = ${userId}
  `) as AuditRow[];
  return rows.length ? rows[0] : null;
}

// Unscoped lookup used only by the internal worker route, which authenticates
// with AUDIT_WORKER_SECRET rather than a Clerk session and so has no user to
// scope by - the row itself carries the user_id/shop it was reserved for.
export async function getAuditByIdInternal(id: string): Promise<AuditRow | null> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql`
    select id, user_id, shop, created_at, overall, result,
           status, progress_step, error_message, error_code, model, truncated, gmc_connected,
           field_snapshots
    from audits
    where id = ${id}
  `) as AuditRow[];
  return rows.length ? rows[0] : null;
}
