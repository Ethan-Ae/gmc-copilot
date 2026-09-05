import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { auth } from "@clerk/nextjs/server";
import { jsonResponse } from "../../../../lib/apiJson";
import { getEnv, isSafeReturnPath, isValidShop } from "../../../../lib/shopify";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const { apiKey, scopes, appUrl } = getEnv();

  const shop = req.nextUrl.searchParams.get("shop")?.trim().toLowerCase();
  if (!shop || !isValidShop(shop)) {
    return jsonResponse(
      { error: "Invalid shop. Use the format your-store.myshopify.com" },
      { status: 400 },
    );
  }

  // No sign-in gate here: Shopify requires its authorization screen to be the
  // first thing an installing merchant sees. When there is no session yet the
  // callback stores the shop unclaimed and the account is linked after sign-up.
  const { userId } = await auth();

  // Optional: where to send the merchant back after a successful connection,
  // e.g. the report page when this is a reconnect prompted by needsReauth
  // (see app/report/page.tsx's ReauthBanner). Only a same-app relative path is
  // accepted; anything else (or absent) falls back to the dashboard in the
  // callback. Carried inside the signed-by-cookie state, not as its own query
  // param, so it cannot be tampered with independently of the CSRF check.
  const returnToRaw = req.nextUrl.searchParams.get("returnTo");
  const returnTo = returnToRaw && isSafeReturnPath(returnToRaw) ? returnToRaw : null;

  // Anti-CSRF random lives in the cookie; the payload carries the userId (when
  // we already have one, e.g. merchant connecting from their dashboard) and
  // the optional returnTo above, base64url-encoded so it never collides with
  // the "." separator used against the random prefix.
  const randomHex = crypto.randomBytes(16).toString("hex");
  const statePayload = Buffer.from(
    JSON.stringify({ userId: userId ?? null, returnTo }),
  ).toString("base64url");
  const state = `${randomHex}.${statePayload}`;
  const redirectUri = `${appUrl}/api/shopify/callback`;

  const authUrl =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${encodeURIComponent(apiKey)}` +
    `&scope=${encodeURIComponent(scopes)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${encodeURIComponent(state)}`;

  const res = NextResponse.redirect(authUrl);
  res.cookies.set("shopify_oauth_state", randomHex, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return res;
}
