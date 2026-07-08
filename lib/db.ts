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
  schemaReady = true;
}

export async function saveShopToken(
  shop: string,
  accessToken: string,
  scope: string | null,
): Promise<void> {
  await ensureSchema();
  const sql = db();
  await sql`
    insert into shops (shop, access_token, scope, updated_at)
    values (${shop}, ${accessToken}, ${scope}, now())
    on conflict (shop) do update
      set access_token = excluded.access_token,
          scope = excluded.scope,
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
