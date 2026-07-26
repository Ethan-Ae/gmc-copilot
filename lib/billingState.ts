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
    create table if not exists billing_state (
      id serial primary key,
      shop text not null unique,
      one_time_status text not null default 'none',
      one_time_charge_id text,
      subscription_status text not null default 'none',
      subscription_id text,
      test_mode boolean not null default false,
      updated_at timestamptz default now()
    )
  `;
  ready = true;
}

// none|pending|active|declined
export type OneTimeStatus = "none" | "pending" | "active" | "declined";
// none|pending|active|cancelled|frozen|declined
export type SubscriptionStatus =
  | "none"
  | "pending"
  | "active"
  | "cancelled"
  | "frozen"
  | "declined";

export type BillingState = {
  shop: string;
  one_time_status: OneTimeStatus;
  one_time_charge_id: string | null;
  subscription_status: SubscriptionStatus;
  subscription_id: string | null;
  test_mode: boolean;
  updated_at: string;
};

export async function getBillingState(
  shop: string,
): Promise<BillingState | null> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql`
    select shop, one_time_status, one_time_charge_id,
           subscription_status, subscription_id, test_mode, updated_at
    from billing_state
    where shop = ${shop}
  `) as BillingState[];
  return rows.length ? rows[0] : null;
}

// Mark a freshly created one-time charge as pending. Subscription columns are
// left untouched on conflict so the two flows never clobber each other.
export async function markOneTimePending(
  shop: string,
  chargeId: string,
  testMode: boolean,
): Promise<void> {
  await ensureSchema();
  const sql = db();
  await sql`
    insert into billing_state (shop, one_time_status, one_time_charge_id, test_mode, updated_at)
    values (${shop}, 'pending', ${chargeId}, ${testMode}, now())
    on conflict (shop) do update
      set one_time_status = 'pending',
          one_time_charge_id = ${chargeId},
          test_mode = ${testMode},
          updated_at = now()
  `;
}

// Mark a freshly created subscription as pending. One-time columns are left
// untouched on conflict.
export async function markSubscriptionPending(
  shop: string,
  subscriptionId: string,
  testMode: boolean,
): Promise<void> {
  await ensureSchema();
  const sql = db();
  await sql`
    insert into billing_state (shop, subscription_status, subscription_id, test_mode, updated_at)
    values (${shop}, 'pending', ${subscriptionId}, ${testMode}, now())
    on conflict (shop) do update
      set subscription_status = 'pending',
          subscription_id = ${subscriptionId},
          test_mode = ${testMode},
          updated_at = now()
  `;
}

// Write the statuses derived from the live Shopify API. This is the source of
// truth called at confirmation return. test_mode is preserved on conflict.
export async function writeSyncedState(
  shop: string,
  synced: {
    oneTimeStatus: OneTimeStatus;
    oneTimeChargeId: string | null;
    subscriptionStatus: SubscriptionStatus;
    subscriptionId: string | null;
  },
): Promise<void> {
  await ensureSchema();
  const sql = db();
  await sql`
    insert into billing_state (
      shop, one_time_status, one_time_charge_id,
      subscription_status, subscription_id, updated_at
    )
    values (
      ${shop}, ${synced.oneTimeStatus}, ${synced.oneTimeChargeId},
      ${synced.subscriptionStatus}, ${synced.subscriptionId}, now()
    )
    on conflict (shop) do update
      set one_time_status = excluded.one_time_status,
          one_time_charge_id = excluded.one_time_charge_id,
          subscription_status = excluded.subscription_status,
          subscription_id = excluded.subscription_id,
          updated_at = now()
  `;
}
