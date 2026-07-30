import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { jsonResponse } from "../../../../../lib/apiJson";
import { isValidShop } from "../../../../../lib/shopify";
import { getShopOwner } from "../../../../../lib/db";
import {
  getShopifyAccessToken,
  ShopifyReauthRequired,
} from "../../../../../lib/shopifyToken";
import { createOneTimeCharge } from "../../../../../lib/shopifyBilling";

export const runtime = "nodejs";
export const maxDuration = 30;

// A shop runs in Shopify Billing test mode when it is listed in the
// comma-separated BILLING_TEST_SHOPS env var (dev stores never charge real
// money).
function isTestShop(shop: string): boolean {
  return (process.env.BILLING_TEST_SHOPS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(shop);
}

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return jsonResponse({ error: "unauthorized" }, { status: 401 });
  }

  let body: { shop?: string; type?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonResponse({ error: "invalid_json" }, { status: 400 });
  }

  const shop = body.shop?.trim().toLowerCase();
  if (!shop || !isValidShop(shop)) {
    return jsonResponse({ error: "invalid_shop" }, { status: 400 });
  }

  // Since the pricing pivot only the one-time 149 CHF charge is sold. The
  // monthly subscription path is retired (createSubscription stays in
  // lib/shopifyBilling.ts but is no longer reachable from here).
  if (body.type !== undefined && body.type !== "one_time") {
    return jsonResponse({ error: "invalid_type" }, { status: 400 });
  }

  // The shop must belong to this user before any Shopify call.
  const owner = await getShopOwner(shop);
  if (owner !== userId) {
    return jsonResponse({ error: "forbidden" }, { status: 403 });
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

  const test = isTestShop(shop);

  try {
    const { confirmationUrl } = await createOneTimeCharge(shop, token, {
      test,
    });
    return jsonResponse({ confirmationUrl });
  } catch (err) {
    return jsonResponse(
      { error: "billing_create_failed", detail: String(err) },
      { status: 502 },
    );
  }
}
