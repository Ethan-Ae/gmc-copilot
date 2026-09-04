import crypto from "crypto";

type ShopifyEnv = {
  apiKey: string;
  apiSecret: string;
  scopes: string;
  appUrl: string;
};

export function getEnv(): ShopifyEnv {
  const apiKey = process.env.SHOPIFY_API_KEY;
  const apiSecret = process.env.SHOPIFY_API_SECRET;
  // Kept in sync with shopify.app.toml's [access_scopes].scopes - this is the
  // scope string sent to /admin/oauth/authorize (app/api/shopify/auth). A
  // shop installed before read_markets/read_shipping were added keeps its
  // narrower granted scope until it goes through OAuth again (this app uses
  // use_legacy_install_flow, so Shopify does not auto-upgrade it) - see
  // lib/auditEngine.ts's needsReauth for how that is detected and surfaced.
  const scopes =
    process.env.SHOPIFY_SCOPES ??
    "write_legal_policies,read_products,write_products,read_markets,read_shipping";
  const appUrl = process.env.SHOPIFY_APP_URL;

  if (!apiKey || !apiSecret || !appUrl) {
    throw new Error(
      "Missing Shopify env vars: SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SHOPIFY_APP_URL",
    );
  }
  return { apiKey, apiSecret, scopes, appUrl };
}

export function isValidShop(shop: string): boolean {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop);
}

export function verifyHmac(query: URLSearchParams, secret: string): boolean {
  const hmac = query.get("hmac");
  if (!hmac) return false;

  const parts: string[] = [];
  query.forEach((value, key) => {
    if (key === "hmac" || key === "signature") return;
    parts.push(`${key}=${value}`);
  });
  const message = parts.sort().join("&");

  const digest = crypto
    .createHmac("sha256", secret)
    .update(message)
    .digest("hex");

  const a = Buffer.from(digest, "utf8");
  const b = Buffer.from(hmac, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export const SHOPIFY_API_VERSION = "2026-04";
