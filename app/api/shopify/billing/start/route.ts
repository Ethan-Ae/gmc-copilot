import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { jsonResponse } from "../../../../../lib/apiJson";
import { isSafeReturnPath, isValidShop } from "../../../../../lib/shopify";
import { getShopOwner } from "../../../../../lib/db";
import {
  getShopifyAccessToken,
  ShopifyReauthRequired,
} from "../../../../../lib/shopifyToken";
import {
  createOneTimeCharge,
  isPartnerDevelopmentShop,
} from "../../../../../lib/shopifyBilling";

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

  let body: { shop?: string; type?: string; returnPath?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonResponse({ error: "invalid_json" }, { status: 400 });
  }

  const shop = body.shop?.trim().toLowerCase();
  if (!shop || !isValidShop(shop)) {
    return jsonResponse({ error: "invalid_shop" }, { status: 400 });
  }

  // Where Shopify should return the merchant after the charge: defaults to
  // the dashboard (see billing/return/route.ts) when absent or unsafe.
  const returnPath =
    body.returnPath && isSafeReturnPath(body.returnPath) ? body.returnPath : undefined;

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

  // A dev/sandbox store reports plan.partnerDevelopment = true regardless of
  // the BILLING_TEST_SHOPS allowlist - always charge it in test mode too.
  // SHOPIFY_BILLING_TEST=true is a blanket override for every shop (used
  // during App Review so a reviewer's charge never touches real money).
  const test =
    process.env.SHOPIFY_BILLING_TEST === "true" ||
    isTestShop(shop) ||
    (await isPartnerDevelopmentShop(shop, token));

  try {
    const { confirmationUrl } = await createOneTimeCharge(shop, token, {
      test,
      returnPath,
    });
    return jsonResponse({ confirmationUrl });
  } catch (err) {
    // Log the raw detail server-side only; clients (ShopBilling.tsx,
    // UnlockButton in app/report/ReportClient.tsx) never read this response's
    // body on failure - they always show a fixed French sentence.
    console.error(`[billing:start] shop=${shop}`, err);
    return jsonResponse({ error: "billing_create_failed" }, { status: 502 });
  }
}
