import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { jsonResponse } from "../../../lib/apiJson";
import { isValidShop, SHOPIFY_API_VERSION } from "../../../lib/shopify";
import { getShopToken, getShopOwner } from "../../../lib/db";

export const runtime = "nodejs";
export const maxDuration = 30;

// The server, never the model, decides what may be written back to Shopify.
// This allowlist is held in hard code here: any fixType outside it is refused
// even if the model set autoApplicable=true (guards against a model mistake or
// a prompt injection). autoApplicable is only a UI hint, never a security gate.
const APPLIABLE_FIX_TYPES = new Set([
  "product_seo",
  "product_compare_at",
  "policy",
]);

type Patch = {
  fixType?: string;
  targetId?: string | null;
  currentValue?: string;
  newValue?: string;
  autoApplicable?: boolean;
};

type Mode = "preview" | "apply";

// Normalise text so a cosmetic whitespace difference is not read as a drift.
function norm(s: unknown): string {
  return typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
}

function eq(a: unknown, b: unknown): boolean {
  return norm(a) === norm(b);
}

async function shopifyGraphQL<T = unknown>(
  shop: string,
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
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
  const json = (await res.json()) as {
    data?: T;
    errors?: unknown;
  };
  if (!res.ok || json.errors) {
    throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors)}`);
  }
  return json.data as T;
}

type UserError = { field?: string[] | null; message: string };

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return jsonResponse({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { shop?: string; patch?: Patch; mode?: Mode };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, { status: 400 });
  }

  const shop = body.shop?.trim().toLowerCase();
  if (!shop || !isValidShop(shop)) {
    return jsonResponse({ error: "Invalid shop" }, { status: 400 });
  }

  const patch = body.patch;
  if (!patch || typeof patch !== "object") {
    return jsonResponse({ error: "Missing patch" }, { status: 400 });
  }

  // preview never writes; apply enforces the anti-drift guard before writing.
  const mode: Mode = body.mode === "apply" ? "apply" : "preview";

  // Ownership: the shop must belong to the signed-in user.
  const owner = await getShopOwner(shop);
  if (owner !== userId) {
    return jsonResponse({ error: "Forbidden" }, { status: 403 });
  }

  const token = await getShopToken(shop);
  if (!token) {
    return jsonResponse(
      { error: "No token in the database. Install the app first." },
      { status: 404 },
    );
  }

  // Security gate: the server, not the model, decides what is writable.
  const fixType = patch.fixType ?? "";
  if (!APPLIABLE_FIX_TYPES.has(fixType)) {
    return jsonResponse(
      {
        status: "refused",
        reason: `fixType '${fixType}' is not auto-applicable`,
      },
      { status: 403 },
    );
  }

  const newValue = patch.newValue ?? "";

  try {
    if (fixType === "product_seo") {
      return await applyProductSeo(shop, token, patch, mode, newValue);
    }
    if (fixType === "product_compare_at") {
      return await applyCompareAt(shop, token, patch, mode, newValue);
    }
    if (fixType === "policy") {
      return await applyPolicy(shop, token, patch, mode, newValue);
    }
    // Unreachable: allowlist already filtered everything else.
    return jsonResponse({ status: "refused" }, { status: 403 });
  } catch (err) {
    return jsonResponse(
      { status: "error", detail: String(err) },
      { status: 502 },
    );
  }
}

// product_seo: the patch carries one string, but it may target the title, the
// descriptionHtml, the SEO title or the SEO description. We read all four live
// and locate the one that still equals patch.currentValue. If none matches, the
// merchant changed the field since the audit -> drift, do not overwrite.
async function applyProductSeo(
  shop: string,
  token: string,
  patch: Patch,
  mode: Mode,
  newValue: string,
) {
  const id = patch.targetId;
  if (!id) {
    return jsonResponse(
      { status: "error", detail: "Missing product targetId" },
      { status: 400 },
    );
  }

  const data = await shopifyGraphQL<{
    product: {
      id: string;
      title: string;
      descriptionHtml: string;
      seo: { title: string | null; description: string | null };
    } | null;
  }>(
    shop,
    token,
    `query($id: ID!) {
      product(id: $id) {
        id
        title
        descriptionHtml
        seo { title description }
      }
    }`,
    { id },
  );

  const product = data.product;
  if (!product) {
    return jsonResponse(
      { status: "error", detail: "Product not found" },
      { status: 404 },
    );
  }

  const candidates: {
    field: string;
    live: string | null;
    input: Record<string, unknown>;
  }[] = [
    { field: "title", live: product.title, input: { title: newValue } },
    {
      field: "descriptionHtml",
      live: product.descriptionHtml,
      input: { descriptionHtml: newValue },
    },
    {
      field: "seo.title",
      live: product.seo?.title ?? null,
      input: { seo: { title: newValue } },
    },
    {
      field: "seo.description",
      live: product.seo?.description ?? null,
      input: { seo: { description: newValue } },
    },
  ];

  const match = candidates.find((c) => eq(c.live, patch.currentValue));

  // Anti-drift: no live field still holds the captured value -> the merchant
  // edited it since the audit. Never overwrite a manual correction.
  if (!match) {
    return jsonResponse({
      status: "drift",
      capturedValue: patch.currentValue ?? "",
      liveValues: candidates.map((c) => ({ field: c.field, value: c.live })),
    });
  }

  if (mode === "preview") {
    return jsonResponse({
      status: "preview",
      field: match.field,
      liveValue: match.live,
      newValue,
    });
  }

  const res = await shopifyGraphQL<{
    productUpdate: { userErrors: UserError[] };
  }>(
    shop,
    token,
    `mutation($input: ProductInput!) {
      productUpdate(input: $input) {
        product { id }
        userErrors { field message }
      }
    }`,
    { input: { id: product.id, ...match.input } },
  );

  const errs = res.productUpdate?.userErrors ?? [];
  if (errs.length) {
    return jsonResponse({ status: "error", userErrors: errs }, { status: 502 });
  }

  return jsonResponse({ status: "applied", field: match.field, newValue });
}

// product_compare_at: targetId is a variant gid. Read the live compare-at price,
// guard against drift, then update via productVariantsBulkUpdate (single-variant
// productVariantUpdate was removed from the Admin API).
async function applyCompareAt(
  shop: string,
  token: string,
  patch: Patch,
  mode: Mode,
  newValue: string,
) {
  const id = patch.targetId;
  if (!id) {
    return jsonResponse(
      { status: "error", detail: "Missing variant targetId" },
      { status: 400 },
    );
  }

  const data = await shopifyGraphQL<{
    productVariant: {
      id: string;
      compareAtPrice: string | null;
      product: { id: string };
    } | null;
  }>(
    shop,
    token,
    `query($id: ID!) {
      productVariant(id: $id) {
        id
        compareAtPrice
        product { id }
      }
    }`,
    { id },
  );

  const variant = data.productVariant;
  if (!variant) {
    return jsonResponse(
      { status: "error", detail: "Variant not found" },
      { status: 404 },
    );
  }

  // Anti-drift on the live compare-at price.
  if (!eq(variant.compareAtPrice ?? "", patch.currentValue ?? "")) {
    return jsonResponse({
      status: "drift",
      capturedValue: patch.currentValue ?? "",
      liveValue: variant.compareAtPrice,
    });
  }

  // An empty replacement means "remove the compare-at price".
  const nextCompareAt = newValue.trim() === "" ? null : newValue.trim();

  if (mode === "preview") {
    return jsonResponse({
      status: "preview",
      field: "compareAtPrice",
      liveValue: variant.compareAtPrice,
      newValue: nextCompareAt,
    });
  }

  const res = await shopifyGraphQL<{
    productVariantsBulkUpdate: { userErrors: UserError[] };
  }>(
    shop,
    token,
    `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants { id compareAtPrice }
        userErrors { field message }
      }
    }`,
    {
      productId: variant.product.id,
      variants: [{ id: variant.id, compareAtPrice: nextCompareAt }],
    },
  );

  const errs = res.productVariantsBulkUpdate?.userErrors ?? [];
  if (errs.length) {
    return jsonResponse({ status: "error", userErrors: errs }, { status: 502 });
  }

  return jsonResponse({
    status: "applied",
    field: "compareAtPrice",
    newValue: nextCompareAt,
  });
}

// policy: shopPolicyUpdate needs the real policy id (gid://shopify/ShopPolicy/..),
// not the type. patch.targetId holds the type (e.g. REFUND_POLICY), so we query
// the shop's policies, map the type to its id, then update. Anti-drift compares
// the live policy body to patch.currentValue before writing.
async function applyPolicy(
  shop: string,
  token: string,
  patch: Patch,
  mode: Mode,
  newValue: string,
) {
  const type = patch.targetId;
  if (!type) {
    return jsonResponse(
      { status: "error", detail: "Missing policy type in targetId" },
      { status: 400 },
    );
  }

  const data = await shopifyGraphQL<{
    shop: {
      shopPolicies: { id: string; type: string; body: string }[];
    };
  }>(
    shop,
    token,
    `{
      shop {
        shopPolicies { id type body }
      }
    }`,
    {},
  );

  const policy = (data.shop?.shopPolicies ?? []).find((p) => p.type === type);
  if (!policy) {
    return jsonResponse(
      { status: "error", detail: `policy not found for type '${type}'` },
      { status: 404 },
    );
  }

  // Anti-drift on the live policy body.
  if (!eq(policy.body, patch.currentValue ?? "")) {
    return jsonResponse({
      status: "drift",
      capturedValue: patch.currentValue ?? "",
      liveValue: policy.body,
    });
  }

  if (mode === "preview") {
    return jsonResponse({
      status: "preview",
      field: type,
      policyId: policy.id,
      liveValue: policy.body,
      newValue,
    });
  }

  const res = await shopifyGraphQL<{
    shopPolicyUpdate: { userErrors: UserError[] };
  }>(
    shop,
    token,
    `mutation($shopPolicy: ShopPolicyInput!) {
      shopPolicyUpdate(shopPolicy: $shopPolicy) {
        shopPolicy { id type }
        userErrors { field message }
      }
    }`,
    { shopPolicy: { id: policy.id, body: newValue } },
  );

  const errs = res.shopPolicyUpdate?.userErrors ?? [];
  if (errs.length) {
    return jsonResponse({ status: "error", userErrors: errs }, { status: 502 });
  }

  return jsonResponse({ status: "applied", field: type, policyId: policy.id });
}
