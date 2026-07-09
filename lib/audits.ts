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

export async function saveAudit(
  userId: string,
  shop: string,
  overall: string,
  result: unknown,
): Promise<void> {
  await ensureSchema();
  const sql = db();
  await sql`
    insert into audits (user_id, shop, overall, result)
    values (${userId}, ${shop}, ${overall}, ${JSON.stringify(result)})
  `;
}

export async function getAuditsForUser(userId: string): Promise<AuditRow[]> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql`
    select id, user_id, shop, created_at, overall, result
    from audits
    where user_id = ${userId}
    order by created_at desc
    limit 50
  `) as AuditRow[];
  return rows;
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
