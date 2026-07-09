import { neon } from "@neondatabase/serverless";

// Lazy client so the build never crashes if the env var is read at import time.
function db() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Missing DATABASE_URL env var");
  return neon(url);
}

let schemaReady = false;
async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  const sql = db();
  await sql`
    create table if not exists shops (
      shop text primary key,
      access_token text not null,
      scope text,
      installed_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `;
  await sql`alter table shops add column if not exists user_id text`;
  schemaReady = true;
}

export async function saveShopToken(
  shop: string,
  accessToken: string,
  scope: string | null,
  userId: string | null = null,
): Promise<void> {
  await ensureSchema();
  const sql = db();
  await sql`
    insert into shops (shop, access_token, scope, user_id, updated_at)
    values (${shop}, ${accessToken}, ${scope}, ${userId}, now())
    on conflict (shop) do update
      set access_token = excluded.access_token,
          scope = excluded.scope,
          user_id = coalesce(excluded.user_id, shops.user_id),
          updated_at = now()
  `;
}

export async function getShopToken(shop: string): Promise<string | null> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql`
    select access_token from shops where shop = ${shop}
  `) as { access_token: string }[];
  return rows.length ? rows[0].access_token : null;
}

export async function getShopOwner(shop: string): Promise<string | null> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql`
    select user_id from shops where shop = ${shop}
  `) as { user_id: string | null }[];
  return rows.length ? rows[0].user_id : null;
}

export async function getShopsForUser(
  userId: string,
): Promise<{ shop: string; updated_at: string }[]> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql`
    select shop, updated_at
    from shops
    where user_id = ${userId}
    order by updated_at desc
  `) as { shop: string; updated_at: string }[];
  return rows;
}
