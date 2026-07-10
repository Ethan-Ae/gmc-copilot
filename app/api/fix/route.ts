import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { jsonResponse } from "../../../lib/apiJson";
import { isValidShop, SHOPIFY_API_VERSION } from "../../../lib/shopify";
import { getShopToken, getShopOwner } from "../../../lib/db";
import { recordFix } from "../../../lib/fixHistory";

export const runtime = "nodejs";
export const maxDuration = 30;

// The single server-side source of truth for what may be written back to
// Shopify. A fixType outside this set is refused even if the model set
// patch.autoApplicable=true. autoApplicable is only a UI hint and is NEVER
// consulted to authorise a write (guards against a model mistake or a prompt
// injection widening the blast radius).
const APPLICABLE_FIX_TYPES = new Set([
  "product_seo",
  "product_compare_at",
  "policy",
]);

type Patch = {
  fixType?: string;
  field?: string | null;
  targetId?: string | null;
  currentValue?: string;
  newValue?: string;
  autoApplicable?: boolean;
};

type Mode = "preview" | "apply";
type UserError = { field?: string[] | null; message: string };

// Normalise text so a cosmetic whitespace difference is not read as a drift.
function norm(s: unknown): string {
  return typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
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
  const json = (await res.json()) as { data?: T; errors?: unknown };
  if (!res.ok || json.errors) {
    throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors)}`);
  }
  return json.data as T;
}

// A resolved write target: the live value currently in Shopify and a closure
// that performs the actual write. Reading happens before we decide anything;
// write() is only invoked in apply mode when there is no drift.
type Target = {
  currentLive: string | null;
  write: (newValue: string) => Promise<UserError[]>;
};

export async function POST(req: NextRequest) {
  // (a) Clerk user.
  const { userId } = await auth();
  if (!userId) {
    return jsonResponse({ error: "unauthorized" }, { status: 401 });
  }

  let body: { shop?: string; patch?: Patch; mode?: Mode; auditId?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonResponse({ error: "invalid_json" }, { status: 400 });
  }

  const shop = body.shop?.trim().toLowerCase();
  if (!shop || !isValidShop(shop)) {
    return jsonResponse({ error: "invalid_shop" }, { status: 400 });
  }

  const patch = body.patch;
  if (!patch || typeof patch !== "object") {
    return jsonResponse({ error: "missing_patch" }, { status: 400 });
  }

  const mode: Mode = body.mode === "apply" ? "apply" : "preview";

  // (b) The shop must belong to this user. Checked before any Shopify call.
  const owner = await getShopOwner(shop);
  if (owner !== userId) {
    return jsonResponse({ error: "forbidden" }, { status: 403 });
  }

  // (c) fixType allowlist. autoApplicable is deliberately ignored here.
  const fixType = patch.fixType ?? "";
  if (!APPLICABLE_FIX_TYPES.has(fixType)) {
    return jsonResponse(
      { error: "fix_type_not_applicable" },
      { status: 403 },
    );
  }

  const token = await getShopToken(shop);
  if (!token) {
    return jsonResponse({ error: "no_token" }, { status: 404 });
  }

  const newValue = patch.newValue ?? "";

  try {
    // Resolve the target and read its live value.
    const target = await resolveTarget(shop, token, fixType, patch);
    if ("error" in target) {
      return jsonResponse(
        { error: target.error },
        { status: target.status },
      );
    }

    const { currentLive } = target;
    const drift = norm(currentLive) !== norm(patch.currentValue ?? "");

    // preview: report the live value and whether it drifted, never write.
    if (mode === "preview") {
      return jsonResponse({
        status: "preview",
        currentLive,
        newValue,
        drift,
      });
    }

    // apply + drift: the merchant changed this field since the audit. Do not
    // overwrite a manual correction.
    if (drift) {
      return jsonResponse({
        status: "drift",
        currentLive,
        capturedValue: patch.currentValue ?? "",
        newValue,
        drift: true,
      });
    }

    // apply, no drift: write, then historise so it can be reverted.
    const userErrors = await target.write(newValue);
    if (userErrors.length) {
      return jsonResponse(
        { status: "error", userErrors },
        { status: 502 },
      );
    }

    const fixId = await recordFix({
      userId,
      shop,
      auditId: body.auditId ?? null,
      fixType,
      field: patch.field ?? null,
      targetId: patch.targetId ?? null,
      previousValue: currentLive,
      newValue,
    });

    return jsonResponse({
      status: "applied",
      fixId,
      field: patch.field ?? null,
      targetId: patch.targetId ?? null,
      previousValue: currentLive,
      newValue,
      drift: false,
    });
  } catch (err) {
    return jsonResponse(
      { status: "error", detail: String(err) },
      { status: 502 },
    );
  }
}

type ResolveError = { error: string; status: number };

async function resolveTarget(
  shop: string,
  token: string,
  fixType: string,
  patch: Patch,
): Promise<Target | ResolveError> {
  if (fixType === "product_seo") {
    return resolveProductSeo(shop, token, patch);
  }
  if (fixType === "product_compare_at") {
    return resolveCompareAt(shop, token, patch);
  }
  if (fixType === "policy") {
    return resolvePolicy(shop, token, patch);
  }
  return { error: "fix_type_not_applicable", status: 403 };
}

// product_seo: the exact field to write is given by patch.field. targetId is the
// product gid.
async function resolveProductSeo(
  shop: string,
  token: string,
  patch: Patch,
): Promise<Target | ResolveError> {
  const id = patch.targetId;
  if (!id) return { error: "missing_target_id", status: 400 };

  const field = patch.field ?? "";
  const seoField =
    field === "seo_description"
      ? "seo.description"
      : field === "seo_title"
        ? "seo.title"
        : field === "descriptionHtml"
          ? "descriptionHtml"
          : null;
  if (!seoField) return { error: "invalid_field", status: 400 };

  const data = await shopifyGraphQL<{
    product: {
      id: string;
      descriptionHtml: string;
      seo: { title: string | null; description: string | null };
    } | null;
  }>(
    shop,
    token,
    `query($id: ID!) {
      product(id: $id) {
        id
        descriptionHtml
        seo { title description }
      }
    }`,
    { id },
  );

  const product = data.product;
  if (!product) return { error: "target_not_found", status: 404 };

  const currentLive: string | null =
    seoField === "descriptionHtml"
      ? product.descriptionHtml
      : seoField === "seo.title"
        ? (product.seo?.title ?? null)
        : (product.seo?.description ?? null);

  return {
    currentLive,
    write: async (newValue: string) => {
      const built =
        seoField === "descriptionHtml"
          ? { descriptionHtml: newValue }
          : seoField === "seo.title"
            ? { seo: { title: newValue } }
            : { seo: { description: newValue } };
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
        { input: { id: product.id, ...built } },
      );
      return res.productUpdate?.userErrors ?? [];
    },
  };
}

// product_compare_at: targetId is a variant gid. The bulk price mutation also
// needs the parent product id, so we read it from the variant.
async function resolveCompareAt(
  shop: string,
  token: string,
  patch: Patch,
): Promise<Target | ResolveError> {
  const id = patch.targetId;
  if (!id) return { error: "missing_target_id", status: 400 };

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
  if (!variant) return { error: "target_not_found", status: 404 };

  return {
    currentLive: variant.compareAtPrice,
    write: async (newValue: string) => {
      // An empty replacement removes the compare-at price.
      const nextCompareAt = newValue.trim() === "" ? null : newValue.trim();
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
      return res.productVariantsBulkUpdate?.userErrors ?? [];
    },
  };
}

// policy: shopPolicyUpdate needs the real ShopPolicy gid, not the type. targetId
// holds the type (e.g. REFUND_POLICY); we query the shop policies and map it to
// its id before writing.
async function resolvePolicy(
  shop: string,
  token: string,
  patch: Patch,
): Promise<Target | ResolveError> {
  const type = patch.targetId;
  if (!type) return { error: "missing_policy_type", status: 400 };

  const data = await shopifyGraphQL<{
    shop: { shopPolicies: { id: string; type: string; body: string }[] };
  }>(
    shop,
    token,
    `{ shop { shopPolicies { id type body } } }`,
    {},
  );

  const policy = (data.shop?.shopPolicies ?? []).find((p) => p.type === type);
  if (!policy) return { error: "policy_not_found", status: 404 };

  return {
    currentLive: policy.body,
    write: async (newValue: string) => {
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
      return res.shopPolicyUpdate?.userErrors ?? [];
    },
  };
}
