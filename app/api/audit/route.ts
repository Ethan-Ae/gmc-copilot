import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { auth } from "@clerk/nextjs/server";
import { jsonResponse } from "../../../lib/apiJson";
import { isValidShop, SHOPIFY_API_VERSION } from "../../../lib/shopify";
import { getShopToken, getShopOwner } from "../../../lib/db";
import { getGoogleTokenForUser } from "../../../lib/googleStore";
import { getMerchantStatus, type MerchantStatus } from "../../../lib/google";
import {
  countAuditsForUserSince,
  createPendingAudit,
  markAuditDone,
  markAuditFailed,
} from "../../../lib/audits";
import { getOrCreateSubscription } from "../../../lib/subscriptions";
import { limitsForPlan, startOfMonthUtc } from "../../../lib/plans";
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

You may also be given a section "STATUT MERCHANT CENTER REEL" holding the live
Merchant Center status (account issues and product issues) for this merchant.
When it is present, compare the risks you detect on the site with the active
account issues, and set each issue "source": "gmc_confirmed" when it matches an
active Merchant Center issue, "both" when you see it both on the site and in
Merchant Center, and "site" when it is only detected from the storefront or
product data. When that section says no Merchant Center status is available,
set "source": "site" on every issue.

For every issue that can be corrected, also fill the "patch" object with the
exact replacement:
- Choose "fixType": "product_seo" for a product title/description/SEO rewrite,
  "product_compare_at" for a suspicious compare-at price, "policy" for a store
  policy page, "page" for other storefront pages (about, contact...), "theme"
  for theme/layout problems, "business_identity" for legal/business identity,
  and "manual_only" when the merchant must act by hand.
- Set "field" to the exact field written, consistent with "fixType":
  "product_seo" -> "seo_description", "seo_title" or "descriptionHtml";
  "product_compare_at" -> "compareAtPrice"; "policy" -> "policy_body". Leave
  "field" null for "page", "theme", "business_identity" and "manual_only".
- Set "targetId" to the EXACT Shopify GID copied character for character from
  the "PRODUCT & VARIANT ID INDEX" section, never invented:
  * "product_seo" and "descriptionHtml" -> the product id (gid://shopify/Product/..).
  * "product_compare_at" -> the id of the SPECIFIC variant concerned
    (gid://shopify/ProductVariant/..), not the product id.
  * "policy" -> the policy type such as "REFUND_POLICY".
- Set "targetHandle" to the product handle copied verbatim from the ID INDEX for
  product_* fixes (fallback for the server), null otherwise.
- "currentValue" is the exact wrong value. "newValue" MUST contain the exact
  final text to write (e.g. the fully rewritten description, the exact new
  compare-at price), NEVER an instruction like "reformuler" or "corriger".
- Set "autoApplicable": true ONLY for "product_seo", "product_compare_at" and
  "policy", where "newValue" is a safe literal value ready to be written back.
  For "theme", "business_identity", "page" and "manual_only" set
  "autoApplicable": false; there "newValue" may be a written instruction.
- Apply the zero-invention rule to "newValue": never introduce a price, delay,
  review, guarantee or any fact that is not already proven in the data you were
  given.
- If you cannot identify the id with certainty, set the whole "patch" to null.
  Never emit a half-filled patch; a patch with a missing or guessed targetId is
  worse than no patch at all.

Write the summary, problem, and fix fields in FRENCH. Keep overall, area,
severity, source, and every "patch" enum/id/value as the English codes and raw
values defined by the tool. In any text you write, do not use long dashes; use
"-". Keep each issue concise.

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
            source: {
              type: "string",
              enum: ["site", "gmc_confirmed", "both"],
              description:
                "Origin of the issue: 'site' if only detected on the storefront/product data, 'gmc_confirmed' if it matches an active Merchant Center account issue, 'both' if seen in both. Use 'site' when no real Merchant Center status was provided.",
            },
            problem: {
              type: "string",
              description:
                "What is wrong and why it risks a GMC review, written in French.",
            },
            fix: {
              type: "string",
              description: "Concrete, verifiable correction, written in French.",
            },
            patch: {
              type: ["object", "null"],
              description:
                "Optional structured correction for this issue. Fill it only when a concrete replacement can be proposed. Omit or set null when nothing can be auto-prepared.",
              properties: {
                fixType: {
                  type: "string",
                  enum: [
                    "product_seo",
                    "product_compare_at",
                    "policy",
                    "page",
                    "theme",
                    "business_identity",
                    "manual_only",
                  ],
                  description:
                    "Kind of correction. product_seo/product_compare_at target Shopify product data, policy targets a store policy page, page/theme/business_identity target storefront content that cannot be changed via a safe automated write.",
                },
                field: {
                  type: ["string", "null"],
                  enum: [
                    "seo_description",
                    "seo_title",
                    "descriptionHtml",
                    "compareAtPrice",
                    "policy_body",
                    null,
                  ],
                  description:
                    "Exact field to write, consistent with fixType. product_seo -> 'seo_description', 'seo_title' or 'descriptionHtml'; product_compare_at -> 'compareAtPrice'; policy -> 'policy_body'. Leave null for non auto-applicable fixTypes.",
                },
                targetId: {
                  type: ["string", "null"],
                  description:
                    "The EXACT Shopify GID copied character for character from the ID INDEX, never invented. For product_seo/descriptionHtml it is the product id (gid://shopify/Product/...). For product_compare_at it is the id of the specific VARIANTE concerned (gid://shopify/ProductVariant/...). For policy it is the policy type such as 'REFUND_POLICY'. If you cannot identify the id with certainty, set the whole patch to null.",
                },
                targetHandle: {
                  type: ["string", "null"],
                  description:
                    "Optional product handle copied verbatim from the ID INDEX. Provide it for product_* fixes as a fallback when the server needs to re-resolve the id. Null otherwise.",
                },
                currentValue: {
                  type: "string",
                  description:
                    "The exact current value that is wrong (title, description, compare-at price, policy text excerpt, etc.).",
                },
                newValue: {
                  type: "string",
                  description:
                    "The exact proposed replacement for product_seo/product_compare_at/policy. For theme/business_identity/page/manual_only it may be a written instruction instead of a literal value. Respect the zero-invention rule: never introduce a fact, price, delay, review or claim that is not already proven in the provided data.",
                },
                autoApplicable: {
                  type: "boolean",
                  description:
                    "true ONLY for product_seo, product_compare_at and policy, where newValue is a safe literal replacement. Always false for page, theme, business_identity and manual_only.",
                },
              },
              required: [
                "fixType",
                "targetId",
                "currentValue",
                "newValue",
                "autoApplicable",
              ],
            },
          },
          required: ["area", "severity", "source", "problem", "fix"],
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
  const { userId } = await auth();
  if (!userId) {
    return jsonResponse({ error: "Unauthorized" }, { status: 401 });
  }

  const shop = req.nextUrl.searchParams.get("shop")?.trim().toLowerCase();
  if (!shop || !isValidShop(shop)) {
    return jsonResponse({ error: "Invalid shop" }, { status: 400 });
  }

  // The shop must belong to the signed-in user before we read or audit it.
  const owner = await getShopOwner(shop);
  if (owner !== userId) {
    return jsonResponse({ error: "Forbidden" }, { status: 403 });
  }

  // Enforce the monthly audit quota for the user's plan before doing any work.
  const sub = await getOrCreateSubscription(userId);
  const limits = limitsForPlan(sub.plan);
  const used = await countAuditsForUserSince(userId, startOfMonthUtc());
  if (used >= limits.auditsPerMonth) {
    return jsonResponse(
      {
        error: "audit_limit_reached",
        plan: sub.plan,
        used,
        limit: limits.auditsPerMonth,
      },
      { status: 402 },
    );
  }

  const token = await getShopToken(shop);
  if (!token) {
    return jsonResponse(
      { error: "No token in the database. Install the app first." },
      { status: 404 },
    );
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return jsonResponse(
      { error: "Missing ANTHROPIC_API_KEY env var" },
      { status: 500 },
    );
  }

  const query = `{
    shop { name myshopifyDomain currencyCode contactEmail }
    products(first: 20) {
      edges {
        node {
          id
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
            edges {
              node { id title price compareAtPrice availableForSale sku }
            }
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
  type VariantNode = {
    id?: string;
    title?: string;
    price?: string;
    compareAtPrice?: string | null;
  };
  type ProductNode = {
    id?: string;
    handle?: string;
    title?: string;
    variants?: { edges?: { node?: VariantNode }[] };
  };
  type ProductEdge = { node?: ProductNode };
  const productEdges: ProductEdge[] = shopData?.data?.products?.edges ?? [];
  const handles = productEdges
    .map((e) => e?.node?.handle)
    .filter((h): h is string => typeof h === "string" && h.length > 0);

  // A compact, clearly labelled index of the real Shopify GIDs so the model can
  // copy targetId/targetHandle verbatim into each patch (never invent an id).
  const idIndex = productEdges
    .map((e) => e?.node)
    .filter((n): n is ProductNode => Boolean(n && n.id))
    .map((n) => {
      const variants = (n.variants?.edges ?? [])
        .map((v) => v?.node)
        .filter((v): v is VariantNode => Boolean(v && v.id))
        .map(
          (v) =>
            `  VARIANTE id="${v.id}" title=${JSON.stringify(v.title ?? "")} ` +
            `price=${JSON.stringify(v.price ?? "")} ` +
            `compareAtPrice=${JSON.stringify(v.compareAtPrice ?? null)}`,
        )
        .join("\n");
      const head =
        `PRODUIT id="${n.id}" handle=${JSON.stringify(n.handle ?? "")} ` +
        `title=${JSON.stringify(n.title ?? "")}`;
      return variants ? `${head}\n${variants}` : head;
    })
    .join("\n");

  // Crawl the public storefront (home, policies, pages, products). A crawl
  // failure must not break the audit, so degrade to an empty result.
  let crawl: CrawlResult;
  try {
    crawl = await crawlStorefront(shop, handles);
  } catch {
    crawl = { locked: false, pages: [] };
  }

  // Real Merchant Center status for the signed-in user, when a Google account is
  // connected. Any failure (no token, API error) must not block the audit.
  let gmcStatus: MerchantStatus | null = null;
  try {
    const googleTok = await getGoogleTokenForUser(userId);
    if (googleTok) {
      gmcStatus = await getMerchantStatus(googleTok.refresh_token);
    }
  } catch {
    gmcStatus = null;
  }

  const anthropic = new Anthropic({ apiKey });
  const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";

  // Reserve the quota row as 'pending' BEFORE the paid Claude call. From here
  // on the attempt counts against the quota even if the call fails afterwards.
  const auditId = await createPendingAudit(userId, shop);

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
            "\n\n1b) PRODUCT & VARIANT ID INDEX (copy these ids verbatim into " +
            "patch.targetId / patch.targetHandle, never invent them):\n" +
            (idIndex || "(no product returned)") +
            "\n\n2) PUBLIC STOREFRONT CONTENT (JSON):\n" +
            JSON.stringify(crawl) +
            (crawl.locked
              ? "\n\nNOTE: the storefront is locked behind a Shopify password " +
                "page, so policies and storefront claims could not be crawled. " +
                'Report a locked storefront (area "theme") and still audit the ' +
                "product data."
              : "") +
            "\n\nSTATUT MERCHANT CENTER REEL:\n" +
            (gmcStatus
              ? JSON.stringify(gmcStatus) +
                "\n\nCompare les risques detectes sur le site avec les account " +
                "issues actives ci-dessus. Marque chaque issue du rapport avec " +
                'le champ "source" ("site", "gmc_confirmed" ou "both").'
              : "Aucun compte Google Merchant Center connecte pour ce marchand. " +
                'Mets "source": "site" sur chaque issue.') +
            "\n\nWrite the summary, problem, and fix fields in French. " +
            "Call report_audit with your findings.",
        },
      ],
    });

    const toolBlock = msg.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    if (!toolBlock) {
      // The paid call happened but returned nothing usable: mark the reserved
      // row failed so it still counts, then report the error.
      await markAuditFailed(auditId).catch(() => {});
      return jsonResponse(
        { error: "Model did not return structured output", stop_reason: msg.stop_reason },
        { status: 502 },
      );
    }

    const audit = toolBlock.input as { overall?: string };

    // Complete the reserved row for the signed-in user (verified above).
    await markAuditDone(auditId, audit.overall ?? "unknown", audit).catch(() => {
      // persistence must never break returning the audit to the caller
    });

    return jsonResponse({
      shop,
      model,
      truncated: msg.stop_reason === "max_tokens",
      audit: toolBlock.input,
    });
  } catch (err) {
    // The call was engaged but errored: keep the reserved row as 'failed' so the
    // attempt is counted against the quota (the Claude cost was paid).
    await markAuditFailed(auditId).catch(() => {});
    return jsonResponse(
      { error: "Anthropic API call failed", detail: String(err) },
      { status: 502 },
    );
  }
}
