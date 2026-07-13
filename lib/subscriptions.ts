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
    create table if not exists subscriptions (
      user_id text primary key,
      plan text not null default 'free',
      status text not null default 'active',
      stripe_customer_id text,
      stripe_subscription_id text,
      current_period_end timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `;
  ready = true;
}

export type Subscription = {
  user_id: string;
  plan: string;
  status: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_end: string | null;
};

// Returns the user's subscription, creating a 'free' row on first access. The
// upsert keeps a single round-trip: on conflict it no-op updates so RETURNING
// always yields the existing (or freshly inserted) row.
export async function getOrCreateSubscription(
  userId: string,
): Promise<Subscription> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql`
    insert into subscriptions (user_id)
    values (${userId})
    on conflict (user_id) do update set updated_at = subscriptions.updated_at
    returning user_id, plan, status, stripe_customer_id,
              stripe_subscription_id, current_period_end
  `) as Subscription[];
  return rows[0];
}
