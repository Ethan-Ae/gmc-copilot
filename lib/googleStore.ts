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
  await sql`alter table google_tokens add column if not exists user_id text`;
  await sql`alter table google_tokens add column if not exists merchant_account_id text`;
  await sql`alter table google_tokens add column if not exists merchant_accounts jsonb`;
  await sql`alter table google_tokens add column if not exists needs_account_choice boolean not null default false`;
  ready = true;
}

// A Merchant Center account this Google user administers.
export type MerchantAccountRef = { id: string; name: string };

export async function saveGoogleToken(
  sub: string,
  email: string | null,
  refreshToken: string,
  accessToken: string | null,
  expiresAt: string | null,
  userId: string | null = null,
): Promise<void> {
  await ensureSchema();
  const sql = db();
  await sql`
    insert into google_tokens (sub, email, refresh_token, access_token, expires_at, user_id, updated_at)
    values (${sub}, ${email}, ${refreshToken}, ${accessToken}, ${expiresAt}, ${userId}, now())
    on conflict (sub) do update set
      email = excluded.email,
      refresh_token = excluded.refresh_token,
      access_token = excluded.access_token,
      expires_at = excluded.expires_at,
      user_id = coalesce(excluded.user_id, google_tokens.user_id),
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

// Google account linked to a specific Clerk user (most recent if several).
export async function getGoogleTokenForUser(
  userId: string,
): Promise<{
  sub: string;
  email: string | null;
  refresh_token: string;
  merchant_account_id: string | null;
} | null> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql`
    select sub, email, refresh_token, merchant_account_id
    from google_tokens
    where user_id = ${userId}
    order by updated_at desc
    limit 1
  `) as {
    sub: string;
    email: string | null;
    refresh_token: string;
    merchant_account_id: string | null;
  }[];
  return rows.length ? rows[0] : null;
}

// Persist the Merchant Center resolution done at OAuth callback time.
export async function saveMerchantResolution(
  sub: string,
  merchantAccountId: string | null,
  accounts: MerchantAccountRef[],
  needsChoice: boolean,
): Promise<void> {
  await ensureSchema();
  const sql = db();
  await sql`
    update google_tokens set
      merchant_account_id = ${merchantAccountId},
      merchant_accounts = ${JSON.stringify(accounts)}::jsonb,
      needs_account_choice = ${needsChoice},
      updated_at = now()
    where sub = ${sub}
  `;
}

// Merchant Center selection state for a Clerk user (dashboard rendering).
export async function getMerchantSelectionForUser(
  userId: string,
): Promise<{
  merchant_account_id: string | null;
  needs_account_choice: boolean;
  accounts: MerchantAccountRef[];
} | null> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql`
    select merchant_account_id, needs_account_choice, merchant_accounts
    from google_tokens
    where user_id = ${userId}
    order by updated_at desc
    limit 1
  `) as {
    merchant_account_id: string | null;
    needs_account_choice: boolean;
    merchant_accounts: MerchantAccountRef[] | null;
  }[];
  if (!rows.length) return null;
  return {
    merchant_account_id: rows[0].merchant_account_id,
    needs_account_choice: rows[0].needs_account_choice,
    accounts: rows[0].merchant_accounts ?? [],
  };
}

// Pick one of the accounts previously stored for THIS user. Returns false when
// the id is not part of the user's own stored list (ownership guard).
export async function selectMerchantAccount(
  userId: string,
  accountId: string,
): Promise<boolean> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql`
    select sub, merchant_accounts
    from google_tokens
    where user_id = ${userId}
    order by updated_at desc
    limit 1
  `) as { sub: string; merchant_accounts: MerchantAccountRef[] | null }[];
  if (!rows.length) return false;
  const owned = (rows[0].merchant_accounts ?? []).some((a) => a.id === accountId);
  if (!owned) return false;
  await sql`
    update google_tokens set
      merchant_account_id = ${accountId},
      needs_account_choice = false,
      updated_at = now()
    where sub = ${rows[0].sub}
  `;
  return true;
}
