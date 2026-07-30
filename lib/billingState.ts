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
  // When the one-time charge became active. Drives the 30-day full-access
  // window (see lib/entitlements.ts). Self-heals if the manual migration
  // (migrations/one_time_expiry.sql) has not run yet.
  await sql`alter table billing_state add column if not exists one_time_purchased_at timestamptz`;
  ready = true;
}

// none|pending|active|declined
export type OneTimeStatus = "none" | "pending" | "active" | "declined";
// none|pending|active|inactive|cancelled|frozen|declined
// 'inactive' is written by the app_subscriptions/update webhook to collapse any
// non-active lifecycle state (cancelled/expired/declined/frozen) into a single
// "monitoring access cut" value. Only 'active' ever grants entitlements.
export type SubscriptionStatus =
  | "none"
  | "pending"
  | "active"
  | "inactive"
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
  one_time_purchased_at: string | null;
};

export async function getBillingState(
  shop: string,
): Promise<BillingState | null> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql`
    select shop, one_time_status, one_time_charge_id,
           subscription_status, subscription_id, test_mode, updated_at,
           one_time_purchased_at
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

// Apply an app_subscriptions/update webhook: set the subscription status and
// record the subscription gid. Only touches existing rows (a subscription
// lifecycle event for a shop we never provisioned billing for is a no-op we log
// upstream). Returns true when a row matched. Idempotent: replaying the same
// webhook writes the same values.
export async function applySubscriptionWebhook(
  shop: string,
  status: SubscriptionStatus,
  subscriptionId: string | null,
): Promise<boolean> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql`
    update billing_state
      set subscription_status = ${status},
          subscription_id = ${subscriptionId},
          updated_at = now()
    where shop = ${shop}
    returning shop
  `) as { shop: string }[];
  return rows.length > 0;
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
  // Stamp the purchase moment the first time we see the one-time charge active.
  // On a fresh row it is now() when active, else null. On conflict we keep the
  // existing timestamp only if the charge was already active (the same 30-day
  // window continues); a new activation after a lapse opens a fresh window.
  const purchasedAt = synced.oneTimeStatus === "active" ? new Date() : null;
  await sql`
    insert into billing_state (
      shop, one_time_status, one_time_charge_id,
      subscription_status, subscription_id, updated_at, one_time_purchased_at
    )
    values (
      ${shop}, ${synced.oneTimeStatus}, ${synced.oneTimeChargeId},
      ${synced.subscriptionStatus}, ${synced.subscriptionId}, now(), ${purchasedAt}
    )
    on conflict (shop) do update
      set one_time_status = excluded.one_time_status,
          one_time_charge_id = excluded.one_time_charge_id,
          subscription_status = excluded.subscription_status,
          subscription_id = excluded.subscription_id,
          updated_at = now(),
          one_time_purchased_at = case
            when ${synced.oneTimeStatus} = 'active' then
              coalesce(
                case when billing_state.one_time_status = 'active'
                  then billing_state.one_time_purchased_at end,
                now()
              )
            else billing_state.one_time_purchased_at
          end
  `;
}
