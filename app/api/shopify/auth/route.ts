import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { auth } from "@clerk/nextjs/server";
import { jsonResponse } from "../../../../lib/apiJson";
import { getEnv, isValidShop } from "../../../../lib/shopify";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const { apiKey, scopes, appUrl } = getEnv();

  const { userId } = await auth();
  if (!userId) {
    return NextResponse.redirect(new URL("/sign-in", req.nextUrl.origin));
  }

  const shop = req.nextUrl.searchParams.get("shop")?.trim().toLowerCase();
  if (!shop || !isValidShop(shop)) {
    return jsonResponse(
      { error: "Invalid shop. Use the format your-store.myshopify.com" },
      { status: 400 },
    );
  }

  // Anti-CSRF random lives in the cookie; the full state carries the userId too.
  const randomHex = crypto.randomBytes(16).toString("hex");
  const state = `${randomHex}.${userId}`;
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
