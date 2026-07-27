import { getBillingState } from "./billingState";
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

// Single source of truth for what a given user may do on a given shop.
// Priority order:
//   1. Shopify Billing on the shop: one-time OR subscription 'active' grants all
//      rights (source 'shopify_billing'). This is the public-app path.
//   2. Legacy per-user 'pro' subscription grants all rights (source
//      'legacy_pro'). Kept for agencies / internal dev accounts.
//   3. Otherwise free rights: limited audit by quota, no fix apply.
export async function getEntitlements(
  userId: string,
  shop: string,
): Promise<Entitlements> {
  // 1) Shopify Billing tied to the shop.
  const billing = await getBillingState(shop);
  if (
    billing &&
    (billing.one_time_status === "active" ||
      billing.subscription_status === "active")
  ) {
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
