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
    create table if not exists google_tokens (
      sub text primary key,
      email text,
      refresh_token text not null,
      access_token text,
      expires_at timestamptz,
      updated_at timestamptz not null default now()
    )
  `;
  ready = true;
}

export async function saveGoogleToken(
  sub: string,
  email: string | null,
  refreshToken: string,
  accessToken: string | null,
  expiresAt: string | null,
): Promise<void> {
  await ensureSchema();
  const sql = db();
  await sql`
    insert into google_tokens (sub, email, refresh_token, access_token, expires_at, updated_at)
    values (${sub}, ${email}, ${refreshToken}, ${accessToken}, ${expiresAt}, now())
    on conflict (sub) do update set
      email = excluded.email,
      refresh_token = excluded.refresh_token,
      access_token = excluded.access_token,
      expires_at = excluded.expires_at,
      updated_at = now()
  `;
}

export async function getGoogleToken(
  sub: string,
): Promise<{ refresh_token: string; email: string | null } | null> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql`
    select refresh_token, email from google_tokens where sub = ${sub}
  `) as { refresh_token: string; email: string | null }[];
  return rows.length ? rows[0] : null;
}

// Most recently connected Google account (used while there is no user/account model yet)
export async function getLatestGoogleToken(): Promise<
  { sub: string; email: string | null; refresh_token: string } | null
> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql`
    select sub, email, refresh_token
    from google_tokens
    order by updated_at desc
    limit 1
  `) as { sub: string; email: string | null; refresh_token: string }[];
  return rows.length ? rows[0] : null;
}
