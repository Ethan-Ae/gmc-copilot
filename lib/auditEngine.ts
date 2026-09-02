import Anthropic from "@anthropic-ai/sdk";
import { SHOPIFY_API_VERSION } from "./shopify";
import {
  createQueuedAudit,
  markAuditDone,
  markAuditFailed,
  updateAuditProgress,
  type AuditSource,
} from "./audits";
import { getGoogleTokenForUser } from "./googleStore";
import {
  getMerchantStatus,
  isMerchantApiError,
  type MerchantStatus,
} from "./google";
import { GMC_SKILL } from "./gmcSkill";
import { crawlStorefront, type CrawlResult } from "./crawl";

// Thrown when the Anthropic key is missing so the caller can map it to a 500.
export class MissingAnthropicKey extends Error {
  constructor() {
    super("Missing ANTHROPIC_API_KEY env var");
    this.name = "MissingAnthropicKey";
  }
}

// Thrown when the paid Claude call returned no structured tool block. The
// reserved audit row is already marked failed before this is raised.
export class ModelNoToolBlock extends Error {
  constructor(public stopReason: string | null) {
    super("Model did not return structured output");
    this.name = "ModelNoToolBlock";
  }
}

export type AuditEngineResult = {
  auditId: string;
  audit: Record<string, unknown>;
  overall: string;
  model: string;
  truncated: boolean;
  gmcConnected: boolean;
  productsAudited: number;
  productsTotal: number | null;
  warnings: string[];
};

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

// A Shopify Admin GraphQL call that must never throw: any network error or
// GraphQL error is caught, logged into `warnings`, and replaced with `fallback`.
// Every Admin API read used by the audit (shop, products, shipping, markets)
// goes through this so one flaky endpoint never fails the whole audit.
async function safeShopifyGraphQL<T>(
  shop: string,
  token: string,
  query: string,
  variables: Record<string, unknown> | undefined,
  fallback: T,
  warningLabel: string,
  warnings: string[],
): Promise<T> {
  try {
    const res = await fetch(
      `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token,
        },
        body: JSON.stringify({ query, variables }),
      },
    );
    const json = await res.json();
    if (!res.ok || json?.errors) {
      warnings.push(`${warningLabel}: ${JSON.stringify(json?.errors ?? res.status)}`);
      return fallback;
    }
    return (json?.data as T) ?? fallback;
  } catch (err) {
    warnings.push(`${warningLabel}: ${String(err)}`);
    return fallback;
  }
}

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
  descriptionHtml?: string;
  seo?: { title?: string | null; description?: string | null };
  variants?: { edges?: { node?: VariantNode }[] };
};
type ProductEdge = { node?: ProductNode };

const PRODUCT_PAGE_SIZE = 50;
const MAX_PRODUCTS = 250;

// Paginate active products by cursor up to MAX_PRODUCTS. A page fetch failure
// stops pagination but keeps whatever was already fetched (never throws), and
// is recorded as a warning so the audit still runs on a partial catalogue.
async function fetchActiveProducts(
  shop: string,
  token: string,
  warnings: string[],
): Promise<{ edges: ProductEdge[]; total: number | null }> {
  const query = `query($first: Int!, $after: String) {
    products(first: $first, after: $after, query: "status:active") {
      pageInfo { hasNextPage endCursor }
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

  type ProductsPage = {
    products?: {
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      edges?: ProductEdge[];
    };
  } | null;

  const edges: ProductEdge[] = [];
  let after: string | null = null;
  for (let page = 0; edges.length < MAX_PRODUCTS; page += 1) {
    const data: ProductsPage = await safeShopifyGraphQL<ProductsPage>(
      shop,
      token,
      query,
      { first: PRODUCT_PAGE_SIZE, after },
      null,
      "products",
      warnings,
    );
    const pageEdges: ProductEdge[] = data?.products?.edges ?? [];
    edges.push(...pageEdges);
    const hasNext: boolean = Boolean(data?.products?.pageInfo?.hasNextPage);
    const nextCursor: string | null = data?.products?.pageInfo?.endCursor ?? null;
    if (!data || !hasNext || !nextCursor || pageEdges.length === 0) break;
    after = nextCursor;
    // Safety valve: never loop more than MAX_PRODUCTS / PRODUCT_PAGE_SIZE + 1
    // pages even if the API misbehaves and keeps reporting hasNextPage.
    if (page > Math.ceil(MAX_PRODUCTS / PRODUCT_PAGE_SIZE) + 1) break;
  }

  const countData = await safeShopifyGraphQL<{
    productsCount?: { count?: number } | null;
  } | null>(
    shop,
    token,
    `{ productsCount(query: "status:active") { count } }`,
    undefined,
    null,
    "productsCount",
    warnings,
  );
  const total = countData?.productsCount?.count ?? null;

  return { edges: edges.slice(0, MAX_PRODUCTS), total };
}

// Runs the full GMC audit pipeline for one shop and persists the result.
// The caller is responsible for obtaining the Shopify token (so it can map a
// ShopifyReauthRequired to the right response) and for any quota/entitlement
// gating. `source` decides whether the reserved row counts against the monthly
// manual quota ('manual') or is a monitoring run that does not ('auto').
//
// When `auditId` is provided (the async worker path), the row was already
// reserved by the caller and this function only updates it. When omitted (the
// synchronous cron re-audit path), a new 'queued' row is reserved here, as
// before.
export async function runAuditForShop(opts: {
  userId: string;
  shop: string;
  token: string;
  source: AuditSource;
  auditId?: string;
  onProgress?: (step: string) => Promise<void>;
}): Promise<AuditEngineResult> {
  const { userId, shop, token, source } = opts;

  // If the caller (the async worker route) already reserved a row, reuse it so
  // a failure below can always mark that same row 'failed' instead of leaving
  // it stuck at 'queued'. Only the synchronous cron path creates a fresh row
  // here, and it does so before anything can fail.
  const auditId = opts.auditId ?? (await createQueuedAudit(userId, shop, source));
  const warnings: string[] = [];

  const reportProgress = async (step: string) => {
    if (opts.onProgress) {
      await opts.onProgress(step).catch(() => {});
    } else {
      await updateAuditProgress(auditId, step).catch(() => {});
    }
  };

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new MissingAnthropicKey();

    await reportProgress("Lecture des produits");

    // Shop identity: never let this throw. A missing shop object still lets
    // the audit run on an empty product list rather than crash the worker.
    const shopInfo = await safeShopifyGraphQL<{
      shop?: {
        name?: string;
        myshopifyDomain?: string;
        currencyCode?: string;
        contactEmail?: string;
      };
    } | null>(
      shop,
      token,
      `{ shop { name myshopifyDomain currencyCode contactEmail } }`,
      undefined,
      null,
      "shop",
      warnings,
    );

    const { edges: productEdges, total: productsTotal } =
      await fetchActiveProducts(shop, token, warnings);

    // Shipping zones/rates and markets/currencies, best-effort context for the
    // shipping and multi-market checks. Never block the audit: an empty result
    // just means the model is told nothing extra was available.
    const shippingData = await safeShopifyGraphQL<{
      deliveryProfiles?: {
        edges?: {
          node?: {
            name?: string;
            profileLocationGroups?: {
              locationGroupZones?: {
                edges?: {
                  node?: {
                    zone?: { name?: string; countries?: { name?: string }[] };
                    methodDefinitions?: {
                      edges?: {
                        node?: {
                          name?: string;
                          rateProvider?: {
                            price?: { amount?: string; currencyCode?: string };
                          };
                        };
                      }[];
                    };
                  };
                }[];
              };
            };
          };
        }[];
      };
    } | null>(
      shop,
      token,
      `{
        deliveryProfiles(first: 5) {
          edges {
            node {
              name
              profileLocationGroups {
                locationGroupZones(first: 10) {
                  edges {
                    node {
                      zone { name countries { name } }
                      methodDefinitions(first: 10) {
                        edges {
                          node {
                            name
                            rateProvider {
                              ... on DeliveryRateDefinition {
                                price { amount currencyCode }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }`,
      undefined,
      null,
      "shippingZones",
      warnings,
    );

    const marketsData = await safeShopifyGraphQL<{
      markets?: { nodes?: { name?: string; enabled?: boolean }[] };
    } | null>(
      shop,
      token,
      `{ markets(first: 20) { nodes { name enabled } } }`,
      undefined,
      null,
      "markets",
      warnings,
    );

    // Product handles from the Admin API feed the storefront product crawl.
    const handles = productEdges
      .map((e) => e?.node?.handle)
      .filter((h): h is string => typeof h === "string" && h.length > 0);

    // A compact, clearly labelled index of the real Shopify GIDs so the model
    // can copy targetId/targetHandle verbatim into each patch (never invent an
    // id).
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

    await reportProgress("Analyse des policies");

    // Crawl the public storefront (home, policies, pages, products). A crawl
    // failure must not break the audit, so degrade to an empty result.
    let crawl: CrawlResult;
    try {
      crawl = await crawlStorefront(shop, handles);
    } catch (err) {
      crawl = { locked: false, pages: [] };
      warnings.push(`crawl: ${String(err)}`);
    }

    await reportProgress("Analyse GMC");

    // Real Merchant Center status for the shop owner, when a Google account is
    // connected. Any failure (no token, API error) must not block the audit.
    let gmcStatus: MerchantStatus | null = null;
    let gmcConnected = false;
    try {
      const googleTok = await getGoogleTokenForUser(userId);
      if (googleTok) {
        gmcConnected = true;
        gmcStatus = await getMerchantStatus(
          googleTok.refresh_token,
          googleTok.merchant_account_id,
        );
      }
    } catch (err) {
      gmcStatus = null;
      warnings.push(`gmc: ${String(err)}`);
    }

    // Build the Merchant Center section. Any part that came back as a structured
    // API error is replaced with an honest factual line, never sent to Claude as
    // if it were real data (which would let the model hallucinate on error JSON).
    let gmcSection: string;
    if (!gmcStatus) {
      gmcSection =
        "Aucun compte Google Merchant Center connecte pour ce marchand. " +
        'Mets "source": "site" sur chaque issue.';
    } else {
      const lines: string[] = [];
      if (isMerchantApiError(gmcStatus.accountIssues)) {
        lines.push(
          `Le statut Merchant Center n'a pas pu etre lu (erreur technique ${gmcStatus.accountIssues.apiError.status}).`,
        );
      } else {
        lines.push(
          "ACCOUNT ISSUES:\n" + JSON.stringify(gmcStatus.accountIssues),
        );
      }
      if (isMerchantApiError(gmcStatus.products)) {
        lines.push(
          `Les problemes produit Merchant Center n'ont pas pu etre lus (erreur technique ${gmcStatus.products.apiError.status}).`,
        );
      } else if (gmcStatus.products != null) {
        lines.push("PRODUCTS:\n" + JSON.stringify(gmcStatus.products));
      }
      lines.push(
        "Compare les risques detectes sur le site avec les account issues " +
          "disponibles ci-dessus. Ne traite pas une erreur technique comme une " +
          'issue Merchant Center. Marque chaque issue du rapport avec le champ ' +
          '"source" ("site", "gmc_confirmed" ou "both").',
      );
      gmcSection = lines.join("\n\n");
    }

    await reportProgress("Generation du rapport");

    const anthropic = new Anthropic({ apiKey });
    const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";

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
            "1) SHOP (JSON):\n" +
            JSON.stringify(shopInfo?.shop ?? null) +
            `\n\n1a) PRODUCTS: ${productEdges.length} active product(s) loaded` +
            (productsTotal != null ? ` out of ${productsTotal} active total` : "") +
            ".\n\n1b) PRODUCT DATA (JSON):\n" +
            JSON.stringify({ edges: productEdges }) +
            "\n\n1c) PRODUCT & VARIANT ID INDEX (copy these ids verbatim into " +
            "patch.targetId / patch.targetHandle, never invent them):\n" +
            (idIndex || "(no product returned)") +
            "\n\n1d) SHIPPING ZONES / RATES (JSON, may be empty if unavailable):\n" +
            JSON.stringify(shippingData ?? null) +
            "\n\n1e) MARKETS (JSON, may be empty if unavailable). The shop's " +
            "primary currency for this audit is shop.currencyCode above; " +
            "never invent a conversion for a secondary market currency:\n" +
            JSON.stringify(marketsData ?? null) +
            "\n\n2) PUBLIC STOREFRONT CONTENT (JSON):\n" +
            JSON.stringify(crawl) +
            (crawl.locked
              ? "\n\nNOTE: the storefront is locked behind a Shopify password " +
                "page, so policies and storefront claims could not be crawled. " +
                'Report a locked storefront (area "theme") and still audit the ' +
                "product data."
              : "") +
            "\n\nSTATUT MERCHANT CENTER REEL:\n" +
            gmcSection +
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
      // row failed so it still counts, then surface a typed error.
      await markAuditFailed(
        auditId,
        "L'analyse a echoue, votre credit n'a pas ete consomme",
      ).catch(() => {});
      throw new ModelNoToolBlock(msg.stop_reason ?? null);
    }

    const audit = toolBlock.input as Record<string, unknown>;
    const overall = (audit.overall as string) ?? "unknown";
    const truncated = msg.stop_reason === "max_tokens";

    // Real per-field values read straight from the Admin API above (not
    // Claude's transcription of them), keyed the same way /api/fix builds its
    // lookup key. Used as the drift baseline so a long descriptionHtml the
    // model paraphrased in its "currentValue" never causes a false drift.
    const fieldSnapshots: Record<string, string> = {};
    for (const edge of productEdges) {
      const p = edge?.node;
      if (!p?.id) continue;
      if (typeof p.descriptionHtml === "string") {
        fieldSnapshots[`${p.id}|descriptionHtml`] = p.descriptionHtml;
      }
      if (p.seo?.title != null) {
        fieldSnapshots[`${p.id}|seo_title`] = p.seo.title ?? "";
      }
      if (p.seo?.description != null) {
        fieldSnapshots[`${p.id}|seo_description`] = p.seo.description ?? "";
      }
      for (const vEdge of p.variants?.edges ?? []) {
        const v = vEdge?.node;
        if (v?.id) {
          fieldSnapshots[`${v.id}|compareAtPrice`] = v.compareAtPrice ?? "";
        }
      }
    }

    await markAuditDone(auditId, overall, audit, {
      model,
      truncated,
      gmcConnected,
      fieldSnapshots,
    }).catch(() => {
      // persistence must never break returning the audit to the caller
    });

    return {
      auditId,
      audit,
      overall,
      model,
      truncated,
      gmcConnected,
      productsAudited: productEdges.length,
      productsTotal,
      warnings,
    };
  } catch (err) {
    if (err instanceof ModelNoToolBlock) throw err;
    // The call was engaged but errored (Shopify or Claude side): keep the
    // reserved row as 'failed' so the attempt is accounted for, with a message
    // the merchant can read, and note the quota was not actually spent.
    await markAuditFailed(
      auditId,
      "L'analyse a echoue, votre credit n'a pas ete consomme",
    ).catch(() => {});
    throw err;
  }
}
