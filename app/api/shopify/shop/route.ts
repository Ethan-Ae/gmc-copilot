import { NextRequest } from "next/server";
import { jsonResponse } from "../../../../lib/apiJson";
import { isValidShop, SHOPIFY_API_VERSION } from "../../../../lib/shopify";
import { getShopToken } from "../../../../lib/db";

export const runtime = "nodejs";

// Proof of persistence: reads the token from the database (no reinstall)
// and uses it to fetch live shop data.
export async function GET(req: NextRequest) {
  const shop = req.nextUrl.searchParams.get("shop")?.trim().toLowerCase();
  if (!shop || !isValidShop(shop)) {
    return jsonResponse({ error: "Invalid shop" }, { status: 400 });
  }

  const token = await getShopToken(shop);
  if (!token) {
    return jsonResponse(
      { connected: false, shop, note: "No token in the database. Install the app first." },
      { status: 404 },
    );
  }

  const query = `{
    shop { name myshopifyDomain currencyCode }
    products(first: 5) { edges { node { title status } } }
  }`;

  const dataRes = await fetch(
    `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query }),
    },
  );
  const data = await dataRes.json();

  return jsonResponse({ connected: true, source: "database", shop, data });
}
