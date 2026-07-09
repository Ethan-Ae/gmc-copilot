import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { auth } from "@clerk/nextjs/server";
import { isValidShop, SHOPIFY_API_VERSION } from "../../../lib/shopify";
import { getShopToken } from "../../../lib/db";
import { saveAudit } from "../../../lib/audits";
import { GMC_SKILL } from "../../../lib/gmcSkill";
import { crawlStorefront, type CrawlResult } from "../../../lib/crawl";

export const runtime = "nodejs";
export const maxDuration = 60;

const SYSTEM = `${GMC_SKILL}

<role>
You are a strict Google Merchant Center (GMC) compliance auditor.
You are given a snapshot of a Shopify store made of two parts:
1. PRODUCT DATA from the Shopify Admin API: shop identity and products.
2. PUBLIC STOREFRONT CONTENT crawled from the live site: the home page, the
   default Shopify policy pages (refund, shipping, privacy, terms of service,
   legal notice, subscription), the contact and about pages, and up to 3 product
   pages. Each crawled page has a url, an HTTP status, and plain text (truncated).
   status 0 means the page could not be fetched; 404 means it does not exist;
   empty text means nothing usable was returned for that page.

You do NOT have Merchant Center data or the feed app in this snapshot.

Audit ONLY what is present. Never invent policies, prices, reviews, delivery
times, or Merchant Center statuses you were not given. If something important is
missing to judge compliance, add an issue with area "needs-verification" instead
of guessing. Apply the zero-invention rule from the knowledge above.

Audit the PRODUCT DATA as before: unsupported claims, hype or risky wording in
titles/descriptions/SEO, suspicious compare-at prices, missing or weak product
data, availability/status mismatches, and anything that reads like marketing
hype rather than a verifiable fact.

Audit the STOREFRONT CONTENT in addition:
- Policy completeness and consistency. Shipping (area "shipping"): delivery time,
  cost, target countries, processing/cutoff. Returns/refunds (area "returns"):
  return window, fees, damaged goods, refund processing time. Contact details and
  legal notice / business identity (area "policy"). Flag a required policy page
  that is missing (status 404) and that GMC relies on.
- Unsupported claims on the storefront (area "claims"): fake or unverifiable
  reviews, star ratings, trust badges, warranties or guarantees not backed by a
  policy, "free delivery" that is not justified, scarcity or urgency, unrealistic
  discounts or compare-at prices.
- Consistency between policies, storefront text, and product data: shipping and
  return terms, currency, prices, availability, business identity, contact.

If the store is locked behind a Shopify password page, you will be told so.
Still audit the product data, and report the locked storefront as an issue with
area "theme" (it blocks a real GMC crawl), noting that policies and storefront
claims could not be verified.

Write the summary, problem, and fix fields in FRENCH. Keep overall, area, and
severity as the English codes defined by the tool. In any text you write, do not
use long dashes; use "-". Keep each issue concise.

Report your findings by calling the report_audit tool.
</role>`;

const AUDIT_TOOL: Anthropic.Tool = {
  name: "report_audit",
  description: "Return the GMC compliance audit result as structured data.",
  input_schema: {
    type: "object",
    properties: {
      overall: {
        type: "string",
        enum: ["go", "warning", "no-go"],
        description: "Overall GMC readiness verdict for the product data checked.",
      },
      summary: {
        type: "string",
        description: "2-3 sentence plain summary of readiness, written in French.",
      },
      issues: {
        type: "array",
        items: {
          type: "object",
          properties: {
            area: {
              type: "string",
              enum: [
                "product",
                "seo",
                "pricing",
                "images",
                "identity",
                "policy",
                "shipping",
                "returns",
                "claims",
                "theme",
                "needs-verification",
              ],
            },
            product: {
              type: ["string", "null"],
              description: "Product title, or null if store-wide.",
            },
            severity: { type: "string", enum: ["high", "medium", "low"] },
            problem: {
              type: "string",
              description:
                "What is wrong and why it risks a GMC review, written in French.",
            },
            fix: {
              type: "string",
              description: "Concrete, verifiable correction, written in French.",
            },
          },
          required: ["area", "severity", "problem", "fix"],
        },
      },
      checked: {
        type: "array",
        items: { type: "string" },
        description: "Short list of what was able to be checked.",
      },
    },
    required: ["overall", "summary", "issues", "checked"],
  },
};

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

  // Product handles from the Admin API feed the storefront product crawl.
  type ProductEdge = { node?: { handle?: string } };
  const productEdges: ProductEdge[] = shopData?.data?.products?.edges ?? [];
  const handles = productEdges
    .map((e) => e?.node?.handle)
    .filter((h): h is string => typeof h === "string" && h.length > 0);

  // Crawl the public storefront (home, policies, pages, products). A crawl
  // failure must not break the audit, so degrade to an empty result.
  let crawl: CrawlResult;
  try {
    crawl = await crawlStorefront(shop, handles);
  } catch {
    crawl = { locked: false, pages: [] };
  }

  const anthropic = new Anthropic({ apiKey });
  const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";

  try {
    const msg = await anthropic.messages.create({
      model,
      max_tokens: 8000,
      system: SYSTEM,
      tools: [AUDIT_TOOL],
      tool_choice: { type: "tool", name: "report_audit" },
      messages: [
        {
          role: "user",
          content:
            "Here is the Shopify store snapshot to audit.\n\n" +
            "1) PRODUCT DATA (JSON):\n" +
            JSON.stringify(shopData?.data ?? shopData) +
            "\n\n2) PUBLIC STOREFRONT CONTENT (JSON):\n" +
            JSON.stringify(crawl) +
            (crawl.locked
              ? "\n\nNOTE: the storefront is locked behind a Shopify password " +
                "page, so policies and storefront claims could not be crawled. " +
                'Report a locked storefront (area "theme") and still audit the ' +
                "product data."
              : "") +
            "\n\nWrite the summary, problem, and fix fields in French. " +
            "Call report_audit with your findings.",
        },
      ],
    });

    const toolBlock = msg.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    if (!toolBlock) {
      return NextResponse.json(
        { error: "Model did not return structured output", stop_reason: msg.stop_reason },
        { status: 502 },
      );
    }

    const audit = toolBlock.input as { overall?: string };

    // Historise the audit against the signed-in user, when there is one.
    const { userId } = await auth();
    if (userId) {
      try {
        await saveAudit(userId, shop, audit.overall ?? "unknown", audit);
      } catch {
        // persistence must never break returning the audit to the caller
      }
    }

    return NextResponse.json({
      shop,
      model,
      truncated: msg.stop_reason === "max_tokens",
      audit: toolBlock.input,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Anthropic API call failed", detail: String(err) },
      { status: 502 },
    );
  }
}
