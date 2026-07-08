import { NextRequest, NextResponse } from "next/server";
import {
  getEnv,
  isValidShop,
  verifyHmac,
  SHOPIFY_API_VERSION,
} from "../../../../lib/shopify";
import { saveShopToken } from "../../../../lib/db";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const { apiKey, apiSecret } = getEnv();
  const params = req.nextUrl.searchParams;

  const shop = params.get("shop")?.trim().toLowerCase();
  const code = params.get("code");
  const state = params.get("state");
  const cookieState = req.cookies.get("shopify_oauth_state")?.value;

  if (!shop || !isValidShop(shop) || !code) {
    return NextResponse.json({ error: "Missing shop or code" }, { status: 400 });
  }
  if (!state || !cookieState || state !== cookieState) {
    return NextResponse.json({ error: "Invalid state" }, { status: 403 });
  }
  if (!verifyHmac(params, apiSecret)) {
    return NextResponse.json({ error: "Invalid HMAC" }, { status: 403 });
  }

  const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: apiKey, client_secret: apiSecret, code }),
  });

  if (!tokenRes.ok) {
    const detail = await tokenRes.text();
    return NextResponse.json({ error: "Token exchange failed", detail }, { status: 502 });
  }

  const tokenJson = (await tokenRes.json()) as {
    access_token: string;
    scope?: string;
  };
  const accessToken = tokenJson.access_token;

  // Persist the token so the connection survives without reinstalling
  await saveShopToken(shop, accessToken, tokenJson.scope ?? null);

  const query = `{
    shop { name myshopifyDomain currencyCode }
    products(first: 5) { edges { node { title status onlineStoreUrl } } }
  }`;

  const dataRes = await fetch(
    `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query }),
    },
  );
  const data = await dataRes.json();

  const res = NextResponse.json(
    {
      connected: true,
      saved_to_db: true,
      shop,
      data,
      note: "Token saved to the database. Visit /api/shopify/shop?shop=<domain> to read it back without reinstalling.",
    },
    { status: 200 },
  );
  res.cookies.delete("shopify_oauth_state");
  return res;
}
