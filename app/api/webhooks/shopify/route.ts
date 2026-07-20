import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { logWebhook, redactShop } from "../../../../lib/webhookLogs";

export const runtime = "nodejs";

// Shopify GDPR mandatory webhooks (customers/data_request, customers/redact,
// shop/redact). A single POST endpoint routes on the X-Shopify-Topic header.
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
// -------------------------------------------------------------------------

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

export async function POST(req: NextRequest) {
  // (a) Read the raw body BEFORE anything else. Parsing to JSON first would
  // re-serialize the bytes and the HMAC would never match.
  const rawBody = await req.text();

  // (b) Reject anything without a valid signature. Mandatory for the Shopify
  // app review.
  const hmacHeader = req.headers.get("x-shopify-hmac-sha256");
  if (!verifyWebhookHmac(rawBody, hmacHeader)) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  // (c) Only now is it safe to parse.
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return new NextResponse("Bad Request", { status: 400 });
  }

  const topic = req.headers.get("x-shopify-topic") ?? "";

  // (d) Route on the topic.
  switch (topic) {
    // We store no end-customer personal data (only shop/product data), so
    // there is nothing to return or erase. We log the request as compliance
    // proof and acknowledge.
    case "customers/data_request":
    case "customers/redact": {
      const shopDomain = extractShopDomain(payload);
      await logWebhook(topic, shopDomain, payload);
      return new NextResponse(null, { status: 200 });
    }

    // Sent 48h after uninstall: erase everything we hold for this shop. We log
    // topic + shop_domain only (NOT the payload), since we are committing to
    // delete this shop's data.
    case "shop/redact": {
      const shopDomain = extractShopDomain(payload);
      if (shopDomain) await redactShop(shopDomain);
      await logWebhook(topic, shopDomain, null);
      return new NextResponse(null, { status: 200 });
    }

    // (e) Unknown topic: log but still 200, so Shopify does not retry.
    default: {
      const shopDomain = extractShopDomain(payload);
      await logWebhook(topic || "unknown", shopDomain, payload);
      return new NextResponse(null, { status: 200 });
    }
  }
}

// Shop domain lives under `shop_domain` in the GDPR payloads. Normalize to the
// same lowercase form the OAuth callback stores.
function extractShopDomain(payload: Record<string, unknown>): string | null {
  const raw = payload["shop_domain"];
  return typeof raw === "string" ? raw.trim().toLowerCase() : null;
}
