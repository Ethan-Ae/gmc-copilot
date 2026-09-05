// Manual smoke test for app/api/webhooks/shopify/route.ts: verifies the two
// contractual outcomes Shopify's App Store review checks for GDPR webhooks -
// a correctly-signed request always gets 200, and a bad signature always
// gets 401 (the only non-200 case). Requires `npm run dev` running in
// parallel on http://localhost:3000.
//
// Usage: npx tsx scripts/smoke-webhook.ts

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import crypto from "node:crypto";

// tsx does not load .env.local the way Next.js does, so read it manually.
function loadEnvLocal(): void {
  const path = resolve(process.cwd(), ".env.local");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvLocal();

const BASE_URL = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const ENDPOINT = `${BASE_URL}/api/webhooks/shopify`;
const BODY = JSON.stringify({ shop_domain: "nonexistent-shop-xyz.myshopify.com" });

function signBody(secret: string, rawBody: string): string {
  return crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
}

async function main(): Promise<void> {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) {
    console.error("[smoke-webhook] FATAL: SHOPIFY_API_SECRET not set (check .env.local)");
    process.exitCode = 1;
    return;
  }

  let failures = 0;

  // 1. Correctly-signed shop/redact for a nonexistent shop -> expect 200.
  {
    const signature = signBody(secret, BODY);
    console.log(`[smoke-webhook] POST ${ENDPOINT} (valid signature, shop/redact, nonexistent shop)`);
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Topic": "shop/redact",
        "X-Shopify-Hmac-Sha256": signature,
        "X-Shopify-Shop-Domain": "nonexistent-shop-xyz.myshopify.com",
      },
      body: BODY,
    });
    const ok = res.status === 200;
    console.log(`[smoke-webhook] -> status=${res.status} expected=200 ${ok ? "PASS" : "FAIL"}`);
    if (!ok) failures += 1;
  }

  // 2. Same payload with a bad signature -> expect 401.
  {
    const badSignature = "not-a-valid-signature==";
    console.log(`[smoke-webhook] POST ${ENDPOINT} (invalid signature, shop/redact)`);
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Topic": "shop/redact",
        "X-Shopify-Hmac-Sha256": badSignature,
        "X-Shopify-Shop-Domain": "nonexistent-shop-xyz.myshopify.com",
      },
      body: BODY,
    });
    const ok = res.status === 401;
    console.log(`[smoke-webhook] -> status=${res.status} expected=401 ${ok ? "PASS" : "FAIL"}`);
    if (!ok) failures += 1;
  }

  if (failures > 0) {
    console.error(`[smoke-webhook] FAIL: ${failures} check(s) failed`);
    process.exitCode = 1;
    return;
  }
  console.log("[smoke-webhook] DONE - both checks passed.");
}

main().catch((err) => {
  console.error("[smoke-webhook] FATAL:", err);
  process.exitCode = 1;
});
