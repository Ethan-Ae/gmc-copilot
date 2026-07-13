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
  // status tracks the lifecycle: 'pending' reserved before the Claude call,
  // 'done' on success, 'failed' when the call errored after being engaged.
  // Existing rows predate this and are treated as completed audits.
  await sql`alter table audits add column if not exists status text not null default 'done'`;
  ready = true;
}

export type AuditRow = {
  id: string;
  user_id: string | null;
  shop: string | null;
  created_at: string;
  overall: string | null;
  result: unknown;
};

// Reserve a quota row as 'pending' right before the paid Claude call. Returns
// the new row id so the caller can later mark it done or failed. Because the
// row exists from this point on, a crash after the Claude call still consumes
// the user's quota.
export async function createPendingAudit(
  userId: string,
  shop: string,
): Promise<string> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql`
    insert into audits (user_id, shop, status)
    values (${userId}, ${shop}, 'pending')
    returning id
  `) as { id: string }[];
  return rows[0].id;
}

export async function markAuditDone(
  id: string,
  overall: string,
  result: unknown,
): Promise<void> {
  await ensureSchema();
  const sql = db();
  await sql`
    update audits
    set status = 'done', overall = ${overall}, result = ${JSON.stringify(result)}
    where id = ${id}
  `;
}

export async function markAuditFailed(id: string): Promise<void> {
  await ensureSchema();
  const sql = db();
  await sql`update audits set status = 'failed' where id = ${id}`;
}

// History only surfaces completed audits, never pending or failed attempts.
export async function getAuditsForUser(userId: string): Promise<AuditRow[]> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql`
    select id, user_id, shop, created_at, overall, result
    from audits
    where user_id = ${userId} and status = 'done'
    order by created_at desc
    limit 50
  `) as AuditRow[];
  return rows;
}

// Counts every attempt that engaged the Claude call (pending + done + failed).
// Requests rejected upstream (401/403/402) never insert a row, so they are not
// counted here.
export async function countAuditsForUserSince(
  userId: string,
  sinceISO: string,
): Promise<number> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql`
    select count(*)::int as n
    from audits
    where user_id = ${userId} and created_at >= ${sinceISO}
  `) as { n: number }[];
  return rows.length ? rows[0].n : 0;
}

export async function getAuditById(
  id: string,
  userId: string,
): Promise<AuditRow | null> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql`
    select id, user_id, shop, created_at, overall, result
    from audits
    where id = ${id} and user_id = ${userId}
  `) as AuditRow[];
  return rows.length ? rows[0] : null;
}
