import { getEnv } from "./shopify";
import { shopifyGraphQL, type UserError } from "./shopifyFix";
import {
  getBillingState,
  markOneTimePending,
  markSubscriptionPending,
  writeSyncedState,
  type OneTimeStatus,
  type SubscriptionStatus,
} from "./billingState";

// REMINDER: to test the billing flow without a real payment, add the dev store
// (e.g. gmc-test-uwz9p8kf.myshopify.com) to BILLING_TEST_SHOPS in Vercel. The
// start route reads that list to pass test: true to Shopify Billing.

// Shopify Billing product definitions. Kept here so the amounts/labels live in
// one place next to the mutations that spend them.
const ONE_TIME_NAME = "Feedcompliant - Mise en conformite";
const ONE_TIME_AMOUNT = 149.0;
const SUBSCRIPTION_NAME = "Feedcompliant - Surveillance";
const SUBSCRIPTION_AMOUNT = 29.0;
const CURRENCY = "CHF";

function returnUrl(shop: string, type: "one_time" | "subscription"): string {
  const { appUrl } = getEnv();
  const url = new URL("/api/shopify/billing/return", appUrl);
  url.searchParams.set("shop", shop);
  url.searchParams.set("type", type);
  return url.toString();
}

function throwOnUserErrors(context: string, errors: UserError[]): void {
  if (errors.length) {
    throw new Error(`Shopify billing ${context}: ${JSON.stringify(errors)}`);
  }
}

// (a) One-time 149 CHF "Mise en conformite" charge. Stores the charge id as
// pending and returns the confirmationUrl the merchant must visit to accept.
export async function createOneTimeCharge(
  shop: string,
  token: string,
  opts: { test: boolean },
): Promise<{ confirmationUrl: string }> {
  const data = await shopifyGraphQL<{
    appPurchaseOneTimeCreate: {
      confirmationUrl: string | null;
      appPurchaseOneTime: { id: string; status: string } | null;
      userErrors: UserError[];
    };
  }>(
    shop,
    token,
    `mutation CreateOneTime($name: String!, $price: MoneyInput!, $returnUrl: URL!, $test: Boolean) {
      appPurchaseOneTimeCreate(name: $name, price: $price, returnUrl: $returnUrl, test: $test) {
        confirmationUrl
        appPurchaseOneTime { id status }
        userErrors { field message }
      }
    }`,
    {
      name: ONE_TIME_NAME,
      price: { amount: ONE_TIME_AMOUNT, currencyCode: CURRENCY },
      returnUrl: returnUrl(shop, "one_time"),
      test: opts.test,
    },
  );

  const payload = data.appPurchaseOneTimeCreate;
  throwOnUserErrors("appPurchaseOneTimeCreate", payload.userErrors ?? []);
  const chargeId = payload.appPurchaseOneTime?.id;
  const confirmationUrl = payload.confirmationUrl;
  if (!chargeId || !confirmationUrl) {
    throw new Error("Shopify billing appPurchaseOneTimeCreate: empty payload");
  }

  await markOneTimePending(shop, chargeId, opts.test);
  return { confirmationUrl };
}

// (b) Recurring 29 CHF/30 days "Surveillance" subscription. Stores the
// subscription id as pending and returns the confirmationUrl.
export async function createSubscription(
  shop: string,
  token: string,
  opts: { test: boolean },
): Promise<{ confirmationUrl: string }> {
  const data = await shopifyGraphQL<{
    appSubscriptionCreate: {
      confirmationUrl: string | null;
      appSubscription: { id: string; status: string } | null;
      userErrors: UserError[];
    };
  }>(
    shop,
    token,
    `mutation CreateSub($name: String!, $returnUrl: URL!, $test: Boolean, $lineItems: [AppSubscriptionLineItemInput!]!) {
      appSubscriptionCreate(name: $name, returnUrl: $returnUrl, test: $test, lineItems: $lineItems) {
        confirmationUrl
        appSubscription { id status }
        userErrors { field message }
      }
    }`,
    {
      name: SUBSCRIPTION_NAME,
      returnUrl: returnUrl(shop, "subscription"),
      test: opts.test,
      lineItems: [
        {
          plan: {
            appRecurringPricingDetails: {
              price: { amount: SUBSCRIPTION_AMOUNT, currencyCode: CURRENCY },
              interval: "EVERY_30_DAYS",
            },
          },
        },
      ],
    },
  );

  const payload = data.appSubscriptionCreate;
  throwOnUserErrors("appSubscriptionCreate", payload.userErrors ?? []);
  const subscriptionId = payload.appSubscription?.id;
  const confirmationUrl = payload.confirmationUrl;
  if (!subscriptionId || !confirmationUrl) {
    throw new Error("Shopify billing appSubscriptionCreate: empty payload");
  }

  await markSubscriptionPending(shop, subscriptionId, opts.test);
  return { confirmationUrl };
}

// Shopify AppPurchaseStatus -> our one_time_status.
function mapOneTimeStatus(status: string | undefined): OneTimeStatus {
  switch (status) {
    case "ACTIVE":
      return "active";
    case "PENDING":
      return "pending";
    case "DECLINED":
      return "declined";
    default:
      // EXPIRED / REFUNDED / anything else: no longer a valid entitlement.
      return "declined";
  }
}

// Shopify AppSubscriptionStatus -> our subscription_status.
function mapSubscriptionStatus(status: string | undefined): SubscriptionStatus {
  switch (status) {
    case "ACTIVE":
      return "active";
    case "PENDING":
      return "pending";
    case "DECLINED":
      return "declined";
    case "FROZEN":
      return "frozen";
    case "CANCELLED":
    case "EXPIRED":
      return "cancelled";
    default:
      return "none";
  }
}

// (c) Read the real Shopify billing state and reconcile billing_state. This is
// the source of truth at confirmation return: never trust the redirect params,
// only what the Admin API reports.
export async function syncBillingState(
  shop: string,
  token: string,
): Promise<void> {
  const existing = await getBillingState(shop);

  const data = await shopifyGraphQL<{
    currentAppInstallation: {
      oneTimePurchases: {
        edges: { node: { id: string; status: string } }[];
      };
      activeSubscriptions: { id: string; status: string }[];
    };
  }>(
    shop,
    token,
    `{
      currentAppInstallation {
        oneTimePurchases(first: 25, sortKey: CREATED_AT, reverse: true) {
          edges { node { id status } }
        }
        activeSubscriptions { id status }
      }
    }`,
    {},
  );

  const install = data.currentAppInstallation;
  const purchases = install?.oneTimePurchases?.edges ?? [];
  const activeSubs = install?.activeSubscriptions ?? [];

  // One-time: prefer the purchase matching the id we recorded; otherwise the
  // most recent one. If none exists, keep whatever we already had.
  const purchaseNode =
    (existing?.one_time_charge_id
      ? purchases.find((e) => e.node.id === existing.one_time_charge_id)?.node
      : undefined) ?? purchases[0]?.node;

  const oneTimeStatus: OneTimeStatus = purchaseNode
    ? mapOneTimeStatus(purchaseNode.status)
    : (existing?.one_time_status ?? "none");
  const oneTimeChargeId: string | null =
    purchaseNode?.id ?? existing?.one_time_charge_id ?? null;

  // Subscription: activeSubscriptions only ever lists ACTIVE plans. Match on our
  // recorded id when present, else take the first active plan. If we had a
  // pending/active subscription that no longer appears, it was not accepted or
  // was cancelled -> mark accordingly rather than inventing an active state.
  const subNode =
    (existing?.subscription_id
      ? activeSubs.find((s) => s.id === existing.subscription_id)
      : undefined) ?? activeSubs[0];

  let subscriptionStatus: SubscriptionStatus;
  let subscriptionId: string | null;
  if (subNode) {
    subscriptionStatus = mapSubscriptionStatus(subNode.status);
    subscriptionId = subNode.id;
  } else if (existing?.subscription_id) {
    subscriptionStatus =
      existing.subscription_status === "active" ? "cancelled" : "declined";
    subscriptionId = existing.subscription_id;
  } else {
    subscriptionStatus = existing?.subscription_status ?? "none";
    subscriptionId = existing?.subscription_id ?? null;
  }

  await writeSyncedState(shop, {
    oneTimeStatus,
    oneTimeChargeId,
    subscriptionStatus,
    subscriptionId,
  });
}
