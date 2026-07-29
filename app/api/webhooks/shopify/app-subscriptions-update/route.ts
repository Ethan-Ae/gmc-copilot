import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { applySubscriptionWebhook } from "../../../../../lib/billingState";
import type { SubscriptionStatus } from "../../../../../lib/billingState";

export const runtime = "nodejs";

// Shopify app_subscriptions/update webhook: keeps billing_state in sync with the
// real lifecycle of the 29 CHF/month monitoring subscription. Same HMAC pattern
// as the GDPR webhooks. It never returns 500 (a 500 would make Shopify retry
// against a bug forever); unexpected states are logged and acknowledged.

// Identical to the GDPR webhook: base64 HMAC-SHA256 of the EXACT raw body, keyed
// on SHOPIFY_API_SECRET, compared in constant time.
function verifyWebhookHmac(rawBody: string, header: string | null): boolean {
  if (!header) return false;
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) return false;

  const digest = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");

  const a = Buffer.from(digest, "utf8");
  const b = Buffer.from(header, "utf8");
  // timingSafeEqual throws on length mismatch, so bail out first.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Shopify AppSubscriptionStatus -> our billing_state.subscription_status.
// ACTIVE unlocks monitoring; every terminal/frozen state cuts it. Any other
// status (e.g. PENDING) is not a definitive access decision, so we skip it.
function mapStatus(status: string): SubscriptionStatus | null {
  switch (status.toUpperCase()) {
    case "ACTIVE":
      return "active";
    case "CANCELLED":
    case "EXPIRED":
    case "DECLINED":
    case "FROZEN":
      return "inactive";
    default:
      return null;
  }
}

export async function POST(req: NextRequest) {
  // (a) Read the raw body BEFORE parsing: re-serializing would break the HMAC.
  const rawBody = await req.text();

  // (b) Reject anything without a valid signature.
  const hmacHeader = req.headers.get("x-shopify-hmac-sha256");
  if (!verifyWebhookHmac(rawBody, hmacHeader)) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  // From here on, always acknowledge with 200 so Shopify never retries a
  // request we already authenticated. Any failure is logged, not surfaced.
  try {
    const shop = req.headers
      .get("x-shopify-shop-domain")
      ?.trim()
      .toLowerCase();
    if (!shop) {
      console.warn("app_subscriptions/update: missing X-Shopify-Shop-Domain header");
      return new NextResponse(null, { status: 200 });
    }

    let payload: { app_subscription?: { admin_graphql_api_id?: string; status?: string } };
    try {
      payload = JSON.parse(rawBody);
    } catch {
      console.warn(`app_subscriptions/update: invalid JSON body for ${shop}`);
      return new NextResponse(null, { status: 200 });
    }

    const sub = payload.app_subscription;
    const rawStatus = sub?.status ?? "";
    const subscriptionId = sub?.admin_graphql_api_id ?? null;

    const status = mapStatus(rawStatus);
    if (!status) {
      console.warn(
        `app_subscriptions/update: unhandled status "${rawStatus}" for ${shop}, skipping`,
      );
      return new NextResponse(null, { status: 200 });
    }

    const matched = await applySubscriptionWebhook(shop, status, subscriptionId);
    if (!matched) {
      console.warn(
        `app_subscriptions/update: no billing_state row for ${shop}, acknowledged without update`,
      );
    }
  } catch (err) {
    console.error(`app_subscriptions/update: unexpected error: ${String(err)}`);
  }

  return new NextResponse(null, { status: 200 });
}
