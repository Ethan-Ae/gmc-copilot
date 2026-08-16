import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { jsonResponse } from "../../../../lib/apiJson";
import { getEnv, isValidShop, verifyHmac } from "../../../../lib/shopify";
import {
  PENDING_SHOP_COOKIE,
  PENDING_SHOP_TTL_SECONDS,
  signPendingShop,
} from "../../../../lib/pendingShopClaim";
import { persistOAuthTokens } from "../../../../lib/shopifyToken";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const { apiKey, apiSecret } = getEnv();
  const params = req.nextUrl.searchParams;

  const shop = params.get("shop")?.trim().toLowerCase();
  const code = params.get("code");
  const state = params.get("state");
  const cookieState = req.cookies.get("shopify_oauth_state")?.value;

  if (!shop || !isValidShop(shop) || !code) {
    return jsonResponse({ error: "Missing shop or code" }, { status: 400 });
  }

  // state = `${randomHex}.${userId}`; randomHex is checked against the cookie.
  // The userId part is empty for an App Store install started without a session.
  const [randomHex, ...userIdParts] = (state ?? "").split(".");
  const stateUserId = userIdParts.join(".") || null;
  if (!randomHex || !cookieState || randomHex !== cookieState) {
    return jsonResponse({ error: "Invalid state" }, { status: 403 });
  }

  // Prefer the userId captured when the flow started; fall back to a live
  // session for a merchant who happens to be signed in already.
  const userId = stateUserId ?? (await auth()).userId ?? null;
  if (!verifyHmac(params, apiSecret)) {
    return jsonResponse({ error: "Invalid HMAC" }, { status: 403 });
  }

  const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    // expiring=1 requests an expiring offline token (access token + refresh
    // token); Shopify no longer accepts non-expiring offline tokens.
    body: JSON.stringify({
      client_id: apiKey,
      client_secret: apiSecret,
      code,
      expiring: 1,
    }),
  });

  if (!tokenRes.ok) {
    const detail = await tokenRes.text();
    return jsonResponse({ error: "Token exchange failed", detail }, { status: 502 });
  }

  const tokenJson = (await tokenRes.json()) as {
    access_token: string;
    scope?: string;
    expires_in?: number;
    refresh_token?: string;
    refresh_token_expires_in?: number;
  };

  // Persist the token pair + expirations so the connection survives without
  // reinstalling and can be refreshed server-side.
  await persistOAuthTokens(shop, tokenJson.scope ?? null, userId, tokenJson);

  // Installed without an account: the row stays orphaned (user_id NULL) and a
  // signed, short-lived cookie carries the shop through sign-up, where
  // /api/shopify/claim attaches it. Sign-up rather than sign-in because an App
  // Store merchant is a new user; Clerk shows the sign-in link on that page.
  if (!userId) {
    const signUpUrl = new URL("/sign-up", req.nextUrl.origin);
    signUpUrl.searchParams.set("redirect_url", "/dashboard");
    const res = NextResponse.redirect(signUpUrl, { status: 303 });
    res.cookies.delete("shopify_oauth_state");
    res.cookies.set(PENDING_SHOP_COOKIE, signPendingShop(shop), {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: PENDING_SHOP_TTL_SECONDS,
    });
    return res;
  }

  // Connection done: hand the merchant back to their dashboard.
  const dashboardUrl = new URL("/dashboard", req.nextUrl.origin);
  const res = NextResponse.redirect(dashboardUrl, { status: 303 });
  res.cookies.delete("shopify_oauth_state");
  return res;
}
