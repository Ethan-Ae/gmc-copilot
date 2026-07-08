import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { isValidShop, SHOPIFY_API_VERSION } from "../../../lib/shopify";
import { getShopToken } from "../../../lib/db";
import { GMC_SKILL } from "../../../lib/gmcSkill";

export const runtime = "nodejs";
export const maxDuration = 60;

const SYSTEM = `${GMC_SKILL}

<role>
You are a strict Google Merchant Center (GMC) compliance auditor.
You are given a PARTIAL snapshot of a Shopify store: shop identity and product data only.
You do NOT have the store policies, theme, or Merchant Center data in this snapshot.

Audit ONLY what is present in the snapshot. Never invent policies, prices, reviews,
or Merchant Center statuses you were not given. If something important is missing to
judge compliance, list it as an issue with area "needs-verification" instead of guessing.

Apply the compliance rules from the knowledge above: unsupported claims, fake or risky
wording in titles/descriptions/SEO, suspicious compare-at prices, missing or weak product
data, availability/status problems, and anything that reads like marketing hype rather
than a verifiable fact.

In any text you write, do not use long dashes. Use "-".

Respond with ONLY a valid JSON object, no markdown, no preamble, in exactly this shape:
{
  "overall": "go" | "warning" | "no-go",
  "summary": "2-3 sentence plain summary of the store's GMC readiness on product data",
  "issues": [
    {
      "area": "product" | "seo" | "pricing" | "images" | "identity" | "needs-verification",
      "product": "product title or null if store-wide",
      "severity": "high" | "medium" | "low",
      "problem": "what is wrong and why it risks a GMC misrepresentation review",
      "fix": "concrete, verifiable correction"
    }
  ],
  "checked": ["short list of what you were able to check"]
}
</role>`;

export async function GET(req: NextRequest) {
  const shop = req.nextUrl.searchParams.get("shop")?.trim().toLowerCase();
  if (!shop || !isValidShop(shop)) {
    return NextResponse.json({ error: "Invalid shop" }, { status: 400 });
  }

  const token = await getShopToken(shop);
  if (!token) {
    return NextResponse.json(
      { error: "No token in the database. Install the app first." },
      { status: 404 },
    );
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Missing ANTHROPIC_API_KEY env var" },
      { status: 500 },
    );
  }

  // Pull the product data the audit needs (read_products scope)
  const query = `{
    shop { name myshopifyDomain currencyCode contactEmail }
    products(first: 20) {
      edges {
        node {
          title
          handle
          status
          descriptionHtml
          seo { title description }
          productType
          vendor
          totalInventory
          featuredImage { url altText }
          variants(first: 5) {
            edges { node { title price compareAtPrice availableForSale sku } }
          }
        }
      }
    }
  }`;

  const shopRes = await fetch(
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
  const shopData = await shopRes.json();

  const anthropic = new Anthropic({ apiKey });
  const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";

  let audit: unknown;
  try {
    const msg = await anthropic.messages.create({
      model,
      max_tokens: 8000,
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content:
            "Here is the Shopify store snapshot to audit (JSON):\n\n" +
            JSON.stringify(shopData?.data ?? shopData) +
            "\n\nReturn ONLY the JSON audit object described in your instructions.",
        },
      ],
    });

    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    try {
      audit = JSON.parse(text.replace(/```json|```/g, "").trim());
    } catch {
      audit = { parse_error: true, raw: text };
    }
  } catch (err) {
    return NextResponse.json(
      { error: "Anthropic API call failed", detail: String(err) },
      { status: 502 },
    );
  }

  return NextResponse.json({ shop, model, audit });
}
