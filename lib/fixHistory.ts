import { neon } from "@neondatabase/serverless";

// Lazy client so the build never crashes if the env var is read at import time.
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
    create table if not exists fix_history (
      id uuid primary key default gen_random_uuid(),
      user_id text not null,
      shop text not null,
      audit_id uuid,
      fix_type text not null,
      field text,
      target_id text,
      previous_value text,
      new_value text,
      applied_at timestamptz not null default now(),
      reverted_at timestamptz
    )
  `;
  ready = true;
}

export type RecordFixInput = {
  userId: string;
  shop: string;
  auditId?: string | null;
  fixType: string;
  field: string | null;
  targetId: string | null;
  previousValue: string | null;
  newValue: string | null;
};

// Persist an applied correction so it can be shown in history and reverted
// later. Returns the new row id.
export async function recordFix(input: RecordFixInput): Promise<string> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql`
    insert into fix_history (
      user_id, shop, audit_id, fix_type, field,
      target_id, previous_value, new_value
    )
    values (
      ${input.userId}, ${input.shop}, ${input.auditId ?? null},
      ${input.fixType}, ${input.field}, ${input.targetId},
      ${input.previousValue}, ${input.newValue}
    )
    returning id
  `) as { id: string }[];
  return rows[0].id;
}

export type FixRow = {
  id: string;
  user_id: string;
  shop: string;
  audit_id: string | null;
  fix_type: string;
  field: string | null;
  target_id: string | null;
  previous_value: string | null;
  new_value: string | null;
  applied_at: string;
  reverted_at: string | null;
};

// Most recent applied corrections for a user, newest first.
export async function getFixHistoryForUser(userId: string): Promise<FixRow[]> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql`
    select id, user_id, shop, audit_id, fix_type, field,
           target_id, previous_value, new_value, applied_at, reverted_at
    from fix_history
    where user_id = ${userId}
    order by applied_at desc
    limit 100
  `) as FixRow[];
  return rows;
}
