import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { getEnv, isValidShop } from "../../../../lib/shopify";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const { apiKey, scopes, appUrl } = getEnv();

  const shop = req.nextUrl.searchParams.get("shop")?.trim().toLowerCase();
  if (!shop || !isValidShop(shop)) {
    return NextResponse.json(
      { error: "Invalid shop. Use the format your-store.myshopify.com" },
      { status: 400 },
    );
  }

  const state = crypto.randomBytes(16).toString("hex");
  const redirectUri = `${appUrl}/api/shopify/callback`;

  const authUrl =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${encodeURIComponent(apiKey)}` +
    `&scope=${encodeURIComponent(scopes)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${state}`;

  const res = NextResponse.redirect(authUrl);
  res.cookies.set("shopify_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return res;
}
