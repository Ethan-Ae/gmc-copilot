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
    create table if not exists webhook_logs (
      id serial primary key,
      topic text not null,
      shop_domain text,
      payload jsonb,
      received_at timestamptz default now()
    )
  `;
  ready = true;
}

// Compliance-proof log line. For customers/* topics we keep the full payload;
// for shop/redact we deliberately pass payload = null since we are about to
// erase everything else we hold about that shop.
export async function logWebhook(
  topic: string,
  shopDomain: string | null,
  payload: unknown | null,
): Promise<void> {
  await ensureSchema();
  const sql = db();
  await sql`
    insert into webhook_logs (topic, shop_domain, payload)
    values (
      ${topic},
      ${shopDomain},
      ${payload === null ? null : JSON.stringify(payload)}
    )
  `;
}

// Erase every row we hold for a shop, triggered by shop/redact (sent 48h after
// uninstall). All three tables key the shop on a `shop` column holding the
// myshopify.com domain. Each delete is guarded independently so a table that
// was never created (e.g. a shop that never ran an audit) cannot abort the
// others and make us fail the webhook.
export async function redactShop(shop: string): Promise<void> {
  const sql = db();
  await deleteWhereShop(sql, "shops", shop);
  await deleteWhereShop(sql, "audits", shop);
  await deleteWhereShop(sql, "fix_history", shop);
}

async function deleteWhereShop(
  sql: ReturnType<typeof db>,
  table: "shops" | "audits" | "fix_history",
  shop: string,
): Promise<void> {
  // Table name is a hard-coded literal (never user input), so interpolating it
  // into the guard is safe; the shop value stays a bound parameter.
  const exists = (await sql`select to_regclass(${"public." + table}) as t`) as {
    t: string | null;
  }[];
  if (!exists.length || exists[0].t === null) return;
  if (table === "shops") {
    await sql`delete from shops where shop = ${shop}`;
  } else if (table === "audits") {
    await sql`delete from audits where shop = ${shop}`;
  } else {
    await sql`delete from fix_history where shop = ${shop}`;
  }
}
