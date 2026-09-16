// Single endpoint for the three mandatory GDPR compliance webhooks
// (customers/data_request, customers/redact, shop/redact - see
// shopify.app.toml) plus app/uninstalled.
//
// Contract Shopify grades during App Store review:
// 1. HMAC verification on the RAW body is the only case that returns a
//    non-200 status (401 on an invalid/missing signature).
// 2. Once verified, respond 200 immediately; do all processing afterwards
//    via next/server's after(). Nothing that happens during processing can
//    change the response that was already sent.
// 3. Processing is idempotent: a shop already deleted, data already absent,
//    or a row that was never created is a silent success, never an error.
//    Every processing path is wrapped in try/catch that only logs.
// 4. Every webhook received is logged server-side (topic, shop domain,
//    result) via lib/webhookLogs.ts, regardless of how processing went.
//
// -- Manual test ----------------------------------------------------------
// Invalid HMAC must be rejected with 401:
//   curl -i -X POST http://localhost:3000/api/webhooks/shopify \
//     -H "X-Shopify-Topic: shop/redact" \
//     -H "X-Shopify-Hmac-Sha256: not-a-valid-signature" \
//     -H "Content-Type: application/json" \
//     -d '{"shop_domain":"demo.myshopify.com"}'
//
// Valid HMAC for a fake shop/redact (uses SHOPIFY_API_SECRET, same secret as
// OAuth). The signature is the base64 HMAC-SHA256 of the EXACT raw body:
//   SECRET="your_shopify_api_secret"
//   BODY='{"shop_domain":"demo.myshopify.com"}'
//   SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -binary | base64)
//   curl -i -X POST http://localhost:3000/api/webhooks/shopify \
//     -H "X-Shopify-Topic: shop/redact" \
//     -H "X-Shopify-Hmac-Sha256: $SIG" \
//     -H "Content-Type: application/json" \
//     --data-binary "$BODY"
// See scripts/smoke-webhook.ts for an automated version of both cases.
// -------------------------------------------------------------------------
import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { verifyWebhookHmac } from "../../../../lib/webhookHmac";
import { logWebhook, redactShop } from "../../../../lib/webhookLogs";
import { applySubscriptionWebhook } from "../../../../lib/billingState";
import { deleteShopToken } from "../../../../lib/db";

export const runtime = "nodejs";

// X-Shopify-Shop-Domain is present on every webhook topic, including
// app/uninstalled - whose payload is a Shop resource with no `shop_domain`
// field (that field only exists on the GDPR compliance payloads). The header
// is the reliable source across all topics; the payload field is kept as a
// fallback for the GDPR topics' documented shape above. Normalize to the same
// lowercase form the OAuth callback stores.
function extractShopDomain(
  req: NextRequest,
  payload: Record<string, unknown> | null,
): string | null {
  const header = req.headers.get("x-shopify-shop-domain")?.trim().toLowerCase();
  if (header) return header;
  if (!payload) return null;
  const raw = payload["shop_domain"];
  return typeof raw === "string" ? raw.trim().toLowerCase() : null;
}

export async function POST(req: NextRequest) {
  // Read the raw body BEFORE anything else. Parsing to JSON first would
  // re-serialize the bytes and the HMAC would never match.
  const rawBody = await req.text();

  // The only path to a non-200 response: an invalid or missing signature.
  const hmacHeader = req.headers.get("x-shopify-hmac-sha256");
  if (!verifyWebhookHmac(rawBody, hmacHeader)) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const topic = req.headers.get("x-shopify-topic") ?? "unknown";

  // From here on we always return 200. Actual processing is deferred to run
  // after the response is sent, so we stay well under any webhook timeout
  // even if a delete is slow, and a processing error can never turn into a
  // non-200 response Shopify would retry.
  after(async () => {
    let payload: Record<string, unknown> | null = null;
    try {
      payload = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      // Signature was valid but the body wasn't JSON we could parse. Already
      // acknowledged with 200 above; just log it and move on.
    }
    const shopDomain = extractShopDomain(req, payload);

    try {
      switch (topic) {
        // We store no end-customer personal data (only shop/product data), so
        // there is nothing additional to export or erase per customer. The
        // logged row is the compliance record of the request.
        case "customers/data_request":
        case "customers/redact": {
          await logWebhook(topic, shopDomain, payload, "ok");
          break;
        }

        // Sent 48h after uninstall: erase everything we hold for this shop.
        // Idempotent - deletes are no-ops if the shop/rows are already gone
        // (see redactShop in lib/webhookLogs.ts). We log topic + shop_domain
        // only (NOT the payload), since we are committing to delete this
        // shop's data.
        case "shop/redact": {
          if (!shopDomain) {
            await logWebhook(topic, shopDomain, null, "no_shop_domain");
            break;
          }
          await redactShop(shopDomain);
          await logWebhook(topic, shopDomain, null, "ok");
          break;
        }

        // Not a GDPR compliance topic, but handled here for the same
        // idempotent-processing guarantees. Cuts billing entitlements
        // immediately instead of waiting on a separate
        // app_subscriptions/update webhook (no-op if we never had a
        // billing_state row for this shop), and deletes the stored access
        // token so a reinstall is never mistaken for an already-authenticated
        // session (see lib/shopifyInstallGate.ts) - Shopify has already
        // revoked it at this point, but leaving it in `shops` would make a
        // reinstall look "connected" until the next live API call failed.
        case "app/uninstalled": {
          if (shopDomain) {
            await applySubscriptionWebhook(shopDomain, "inactive", null);
            await deleteShopToken(shopDomain);
          }
          await logWebhook(topic, shopDomain, payload, "ok");
          break;
        }

        // Unknown topic: still logged and acknowledged so Shopify never
        // retries.
        default: {
          await logWebhook(topic, shopDomain, payload, "ok");
        }
      }
    } catch (err) {
      console.error(
        `[webhook] ${topic} processing failed for ${shopDomain ?? "unknown"}: ${String(err)}`,
      );
      await logWebhook(topic, shopDomain, null, `error: ${String(err)}`);
    }
  });

  return new NextResponse(null, { status: 200 });
}
