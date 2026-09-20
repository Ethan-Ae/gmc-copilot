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

// Shopify App Store listing URL. Manual shop-domain entry is not allowed
// anywhere in the app (App Review 2.3.2): every "connect your store" surface
// points here instead, and installation itself drives the OAuth flow.
export function getShopifyAppStoreUrl(): string {
  const url = process.env.SHOPIFY_APP_STORE_URL;
  if (!url) {
    throw new Error("Missing Shopify env var: SHOPIFY_APP_STORE_URL");
  }
  return url;
}

// Used to validate the optional "returnTo" carried through the OAuth state
// (see app/api/shopify/auth and app/api/shopify/callback): only a same-app
// relative path is ever accepted, so a forged value can never turn the OAuth
// callback into an open redirect to an external host. Rejects an absolute URL
// (contains "://"), a protocol-relative one ("//host/..."), and anything not
// starting with exactly one leading slash.
export function isSafeReturnPath(path: string): boolean {
  return /^\/(?!\/)\S*$/.test(path) && !path.includes("://");
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

// How stale a signed "timestamp" query param may be before we stop trusting
// the request enough to act on shop+hmac (see lib/shopifyInstallGate.ts).
// Shopify does not document a required window; 24h is generous enough to
// never reject a real launch link while still refusing an old/replayed one.
export const HMAC_TIMESTAMP_TOLERANCE_SECONDS = 24 * 60 * 60;

export function isHmacTimestampFresh(query: URLSearchParams): boolean {
  const raw = query.get("timestamp");
  if (!raw) return false;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds)) return false;
  const ageSeconds = Math.abs(Date.now() / 1000 - seconds);
  return ageSeconds <= HMAC_TIMESTAMP_TOLERANCE_SECONDS;
}
