import { getBillingState, type BillingState } from "./billingState";
import { getOrCreateSubscription } from "./subscriptions";

// Where a user's full rights come from, for display and debugging.
export type EntitlementSource = "shopify_billing" | "legacy_pro" | "free";

export type Entitlements = {
  // A full audit is the paid tier (higher monthly quota). Free stays capped by
  // the existing per-month quota.
  canFullAudit: boolean;
  // Whether applying (writing) fixes back to Shopify is allowed.
  canApplyFixes: boolean;
  source: EntitlementSource;
};

const FREE: Entitlements = {
  canFullAudit: false,
  canApplyFixes: false,
  source: "free",
};

// The one-time 149 CHF "Mise en conformite" charge grants full access to the
// shop for this long, then the shop falls back to teaser/free.
const ACCESS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// True when the shop has an active one-time charge whose 30-day window is still
// open. A charge that is active but whose purchase date was never captured
// (legacy row before the one_time_purchased_at column) is granted access: the
// date is stamped on the next billing sync, so this is a short-lived grace.
export function oneTimeAccessActive(
  billing: BillingState | null,
  now: Date = new Date(),
): boolean {
  if (!billing || billing.one_time_status !== "active") return false;
  const purchasedAt = billing.one_time_purchased_at;
  if (!purchasedAt) return true;
  const age = now.getTime() - new Date(purchasedAt).getTime();
  return age >= 0 && age < ACCESS_WINDOW_MS;
}

// True when a one-time charge is active but its 30-day window has elapsed. Used
// by the dashboard to show the "access expired, re-run a compliance" banner.
export function oneTimeAccessExpired(
  billing: BillingState | null,
  now: Date = new Date(),
): boolean {
  return (
    billing?.one_time_status === "active" &&
    !oneTimeAccessActive(billing, now)
  );
}

// Single source of truth for what a given user may do on a given shop.
// Priority order:
//   1. Shopify Billing one-time charge on the shop, active and under 30 days
//      old, grants all rights (source 'shopify_billing'). This is the public
//      pay-per-shop path since the pivot away from the monthly subscription.
//   2. Legacy per-user 'pro' subscription grants all rights (source
//      'legacy_pro'). Kept for agencies / internal dev accounts.
//   3. Otherwise free rights: limited audit by quota, no fix apply.
// subscription_status no longer grants any right: the monthly "Surveillance"
// plan was retired. The column and its webhook are kept but read nowhere here.
export async function getEntitlements(
  userId: string,
  shop: string,
): Promise<Entitlements> {
  // 1) Shopify Billing one-time charge tied to the shop, within its window.
  const billing = await getBillingState(shop);
  if (oneTimeAccessActive(billing)) {
    return {
      canFullAudit: true,
      canApplyFixes: true,
      source: "shopify_billing",
    };
  }

  // 2) Legacy per-user 'pro' plan (agencies / dev).
  const sub = await getOrCreateSubscription(userId);
  if (sub.plan === "pro") {
    return { canFullAudit: true, canApplyFixes: true, source: "legacy_pro" };
  }

  // 3) Default free entitlements.
  return FREE;
}
