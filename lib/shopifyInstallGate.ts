import { NextRequest, NextResponse } from "next/server";
import {
  getEnv,
  isHmacTimestampFresh,
  isValidShop,
  verifyHmac,
  SHOPIFY_API_VERSION,
} from "./shopify";
import { deleteShopToken, getShopToken } from "./db";

// Injectable so scripts/smoke-install-gate.ts can exercise the decision table
// without a live DB connection or real Shopify shop. Defaults below are the
// real implementations used in production.
export type InstallGateDeps = {
  getShopToken: (shop: string) => Promise<string | null>;
  deleteShopToken: (shop: string) => Promise<void>;
  isTokenValid: (shop: string, token: string) => Promise<boolean>;
};

const defaultDeps: InstallGateDeps = {
  getShopToken,
  deleteShopToken,
  isTokenValid: checkTokenValidAgainstShopify,
};

// The gate must NEVER run on the app's own OAuth/billing/webhook/Google
// machinery, or it self-destructs: /api/shopify/callback lands with a
// Shopify-signed shop+hmac+code+timestamp on every install, and at that
// exact moment no token has been persisted yet (the exchange happens inside
// the callback handler itself, using `code`) - so the gate would see "no
// token" and bounce back to /api/shopify/auth, which starts a new OAuth
// round that lands back on the same callback: an infinite loop on every
// single install. Checked by pathname, independent of the middleware
// matcher in proxy.ts, so a future matcher change can't silently reopen this.
const EXCLUDED_PATH_PREFIXES = ["/api/shopify/", "/api/webhooks/", "/api/google/"];

function isExcludedPath(pathname: string): boolean {
  return EXCLUDED_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

// Runs in middleware (see proxy.ts) for every non-static request, i.e. the
// root URL and every other app URL alike (except the excluded prefixes
// above). Shopify appends shop+hmac (+timestamp, host, embedded, ...)
// whenever it opens the app - on first install, on every reinstall after an
// uninstall, and every time a merchant relaunches it from the Shopify admin.
// Per Shopify App Review rule 2.3.2, OAuth must run before any UI renders in
// every one of those cases. Returns a redirect/breakout response when OAuth
// must happen first, or null when the request either isn't a signed Shopify
// launch, targets excluded app machinery, or is already backed by a valid
// token - in all of those cases normal routing/rendering proceeds untouched.
export async function resolveInboundShopifyRequest(
  req: NextRequest,
  deps: InstallGateDeps = defaultDeps,
): Promise<NextResponse | null> {
  if (isExcludedPath(req.nextUrl.pathname)) return null;

  const params = req.nextUrl.searchParams;
  const shop = params.get("shop")?.trim().toLowerCase();
  if (!shop || !isValidShop(shop)) return null;
  if (!params.get("hmac")) return null;

  let apiSecret: string;
  try {
    ({ apiSecret } = getEnv());
  } catch {
    // Shopify env not configured: never block normal routing over it.
    return null;
  }

  if (!verifyHmac(params, apiSecret)) {
    // Never log the hmac, the secret, or the access token - only enough to
    // spot a secret mismatch (see the 2026-09-20 signed-launch incident).
    console.error("[install-gate] hmac invalid", { path: req.nextUrl.pathname, shop });
    return null;
  }
  // Stale/replayed signed link: do not trust the shop claim enough to act on
  // it (neither to force OAuth nor to skip it) - fall through to normal
  // rendering, same as an unsigned request.
  if (!isHmacTimestampFresh(params)) return null;

  const embedded = params.get("embedded") === "1";
  const authorizeUrl = new URL("/api/shopify/auth", req.nextUrl.origin);
  // Forward every param exactly as Shopify sent it (shop, hmac, timestamp,
  // host, ...), unmodified, so /api/shopify/auth can re-verify the same HMAC
  // itself: that route excludes this path from the gate (see
  // EXCLUDED_PATH_PREFIXES) and must not start OAuth for a shop it has not
  // independently confirmed came from a real signed Shopify launch.
  params.forEach((value, key) => authorizeUrl.searchParams.set(key, value));

  const token = await deps.getShopToken(shop);
  if (!token || !(await deps.isTokenValid(shop, token))) {
    if (token) await deps.deleteShopToken(shop);
    return embedded ? iframeBreakout(authorizeUrl) : NextResponse.redirect(authorizeUrl);
  }

  return null;
}

// Minimal liveness check against the Admin API. 401/403 means the token was
// revoked (e.g. the shop uninstalled and reinstalled) - anything else
// (network hiccup, 5xx) is treated as "still valid" so a transient Shopify
// outage never forces every merchant back through OAuth at once.
async function checkTokenValidAgainstShopify(shop: string, token: string): Promise<boolean> {
  try {
    const res = await fetch(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token,
        },
        body: JSON.stringify({ query: "{ shop { id } }" }),
      },
    );
    if (res.status === 401 || res.status === 403) return false;
    if (!res.ok) return true;
    const json = (await res.json().catch(() => null)) as {
      data?: { shop?: { id?: string } };
    } | null;
    return Boolean(json?.data?.shop?.id);
  } catch {
    return true;
  }
}

// embedded=false in shopify.app.toml means the app should never actually run
// inside Shopify's admin iframe, but Shopify can still send embedded=1 on the
// launch URL. A server-side redirect only navigates the iframe itself, not
// the top-level browser window, so OAuth's admin authorization screen (which
// refuses to render inside a frame) would silently fail. This breaks out of
// any frame before handing off to OAuth, exactly the way a real 302 would for
// a non-framed request.
function iframeBreakout(target: URL): NextResponse {
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>window.top.location.href = ${JSON.stringify(target.toString())};</script></body></html>`;
  return new NextResponse(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
