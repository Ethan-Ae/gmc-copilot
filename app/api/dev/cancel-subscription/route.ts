import { NextRequest } from "next/server";
import { jsonResponse } from "../../../../lib/apiJson";
import { isValidShop } from "../../../../lib/shopify";
import { getBillingState } from "../../../../lib/billingState";
import {
  getShopifyAccessToken,
  ShopifyReauthRequired,
} from "../../../../lib/shopifyToken";
import { shopifyGraphQL, type UserError } from "../../../../lib/shopifyFix";

export const runtime = "nodejs";

// Dev-only helper to exercise the app_subscriptions/update webhook without
// uninstalling the app: cancels the shop's active subscription in Shopify, which
// makes Shopify send a CANCELLED webhook. Gated to test shops only.
function isTestShop(shop: string): boolean {
  return (process.env.BILLING_TEST_SHOPS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(shop);
}

export async function POST(req: NextRequest) {
  let body: { shop?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonResponse({ error: "invalid_json" }, { status: 400 });
  }

  const shop = body.shop?.trim().toLowerCase();
  if (!shop || !isValidShop(shop)) {
    return jsonResponse({ error: "invalid_shop" }, { status: 400 });
  }

  // Protection: this route does not exist for non-test shops.
  if (!isTestShop(shop)) {
    return jsonResponse({ error: "not_found" }, { status: 404 });
  }

  const billing = await getBillingState(shop);
  const subscriptionId = billing?.subscription_id;
  if (!subscriptionId) {
    return jsonResponse({ error: "no_subscription" }, { status: 404 });
  }

  let token: string;
  try {
    token = await getShopifyAccessToken(shop);
  } catch (err) {
    if (err instanceof ShopifyReauthRequired) {
      return jsonResponse({ error: "shopify_reauth_required" }, { status: 401 });
    }
    return jsonResponse({ error: "shopify_token_error" }, { status: 502 });
  }

  try {
    const data = await shopifyGraphQL<{
      appSubscriptionCancel: {
        appSubscription: { id: string; status: string } | null;
        userErrors: UserError[];
      };
    }>(
      shop,
      token,
      `mutation CancelSub($id: ID!) {
        appSubscriptionCancel(id: $id) {
          appSubscription { id status }
          userErrors { field message }
        }
      }`,
      { id: subscriptionId },
    );

    const payload = data.appSubscriptionCancel;
    if (payload.userErrors?.length) {
      return jsonResponse(
        { error: "cancel_failed", userErrors: payload.userErrors },
        { status: 502 },
      );
    }

    return jsonResponse({
      id: payload.appSubscription?.id ?? subscriptionId,
      status: payload.appSubscription?.status ?? null,
    });
  } catch (err) {
    return jsonResponse(
      { error: "cancel_failed", detail: String(err) },
      { status: 502 },
    );
  }
}
