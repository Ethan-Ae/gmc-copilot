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

Audit ONLY what is present. Never invent policies, prices, reviews, or Merchant Center
statuses you were not given. If something important is missing to judge compliance, add an
issue with area "needs-verification" instead of guessing.

Apply the compliance rules from the knowledge above: unsupported claims, hype or risky
wording in titles/descriptions/SEO, suspicious compare-at prices, missing or weak product
data, availability/status mismatches, and anything that reads like marketing hype rather
than a verifiable fact.

In any text you write, do not use long dashes; use "-". Keep each issue concise.

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
        description: "2-3 sentence plain summary of readiness.",
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
              description: "What is wrong and why it risks a GMC review.",
            },
            fix: { type: "string", description: "Concrete, verifiable correction." },
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
            "Here is the Shopify store snapshot to audit (JSON):\n\n" +
            JSON.stringify(shopData?.data ?? shopData) +
            "\n\nCall report_audit with your findings.",
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
