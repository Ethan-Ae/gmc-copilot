import { SHOPIFY_API_VERSION } from "./shopify";

// The single server-side source of truth for what may be written back to
// Shopify. A fixType outside this set is refused even if the model set
// patch.autoApplicable=true. autoApplicable is only a UI hint and is NEVER
// consulted to authorise a write (guards against a model mistake or a prompt
// injection widening the blast radius).
export const APPLICABLE_FIX_TYPES = new Set([
  "product_seo",
  "product_compare_at",
  "policy",
  "partial",
]);

export type Patch = {
  fixType?: string;
  field?: string | null;
  targetId?: string | null;
  targetHandle?: string | null;
  // Multi-product fix: the SAME literal phrase is removed/replaced across
  // several products in one issue instead of one patch per product. Only
  // supported for fixType "product_seo" + field "descriptionHtml". When set,
  // targetId/newValue are ignored server-side; targetId/currentValue/newValue
  // on the patch are kept only as a representative example for display.
  targetIds?: string[] | null;
  findText?: string | null;
  replaceText?: string | null;
  currentValue?: string;
  newValue?: string;
  autoApplicable?: boolean;
};

// A Shopify Admin GID, e.g. gid://shopify/Product/123.
function isGid(s: unknown): s is string {
  return typeof s === "string" && /^gid:\/\/shopify\/\w+\/\d+/.test(s);
}

export type Mode = "preview" | "apply";

export type UserError = { field?: string[] | null; message: string };

// A resolved write target: the live value currently in Shopify and a closure
// that performs the actual write. Reading happens before we decide anything;
// write() is only invoked when there is no drift.
export type Target = {
  currentLive: string | null;
  write: (newValue: string) => Promise<UserError[]>;
};

export type ResolveError = { error: string; status: number };

// The second half of a field_snapshots key (see lib/auditEngine.ts's
// fieldSnapshots) does not always equal the wire "field" the model sends: for
// policy/partial the wire field is one of the policy type constants (matching
// targetId, per the tool schema's field enum), but auditEngine always
// snapshots policies under the fixed suffix "policy_body". Exported so both
// the /api/fix route and scripts/smoke-fix.ts translate the same way.
export function snapshotFieldFor(
  fixType: string,
  field: string | null | undefined,
): string | null {
  if (fixType === "policy" || fixType === "partial") return "policy_body";
  return field ?? null;
}

const HTML_ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, ent: string) => {
    if (ent[0] === "#") {
      const code =
        ent[1] === "x" || ent[1] === "X"
          ? parseInt(ent.slice(2), 16)
          : parseInt(ent.slice(1), 10);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    return HTML_ENTITY_MAP[ent] ?? match;
  });
}

function stripHtmlTags(s: string): string {
  return s.replace(/<[^>]*>/g, " ");
}

// Normalise text so a cosmetic difference is never read as a drift: trims,
// collapses whitespace, unifies line endings, and decodes HTML entities (a
// live re-read can come back "&amp;" where the snapshot had "&", etc). Pass
// stripTags for descriptionHtml, since Shopify may re-serialise the exact
// same visible content with different markup between two reads.
export function norm(s: unknown, opts?: { stripTags?: boolean }): string {
  if (typeof s !== "string") return "";
  let out = opts?.stripTags ? stripHtmlTags(s) : s;
  out = decodeHtmlEntities(out);
  out = out.replace(/\r\n?/g, "\n").replace(/\s+/g, " ").trim();
  return out;
}

export async function shopifyGraphQL<T = unknown>(
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

export async function resolveTarget(
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
  if (fixType === "policy" || fixType === "partial") {
    return resolvePolicy(shop, token, patch);
  }
  return { error: "fix_type_not_applicable", status: 403 };
}

// product_seo: the exact field to write is given by patch.field. targetId is the
// product gid. Aliases kept for audits generated before the field enum below
// was tightened - resolved here rather than rejected, so an already-open
// report page never hard-fails with invalid_field after a prompt/schema
// change.
const FIELD_ALIASES: Record<string, string> = {
  seo_title: "seo.title",
  seo_description: "seo.description",
};
const PRODUCT_FIELDS = new Set([
  "title",
  "descriptionHtml",
  "seo.title",
  "seo.description",
  "productType",
  "vendor",
  "tags",
]);

function normalizeProductField(raw: string | null | undefined): string | null {
  const field = (raw ?? "").trim();
  const resolved = FIELD_ALIASES[field] ?? field;
  return PRODUCT_FIELDS.has(resolved) ? resolved : null;
}

type SeoProduct = {
  id: string;
  title: string;
  descriptionHtml: string;
  productType: string | null;
  vendor: string | null;
  tags: string[];
  seo: { title: string | null; description: string | null };
};

const SEO_PRODUCT_FIELDS = `id title descriptionHtml productType vendor tags seo { title description }`;

// Resolve the product either by its GID or, as a fallback, by its handle.
async function fetchSeoProduct(
  shop: string,
  token: string,
  patch: Patch,
): Promise<SeoProduct | null | ResolveError> {
  if (isGid(patch.targetId)) {
    const data = await shopifyGraphQL<{ product: SeoProduct | null }>(
      shop,
      token,
      `query($id: ID!) { product(id: $id) { ${SEO_PRODUCT_FIELDS} } }`,
      { id: patch.targetId },
    );
    return data.product;
  }
  if (patch.targetHandle) {
    const data = await shopifyGraphQL<{
      products: { edges: { node: SeoProduct }[] };
    }>(
      shop,
      token,
      `query($q: String!) {
        products(first: 1, query: $q) {
          edges { node { ${SEO_PRODUCT_FIELDS} } }
        }
      }`,
      { q: `handle:${patch.targetHandle}` },
    );
    return data.products?.edges?.[0]?.node ?? null;
  }
  return { error: "missing_target_id", status: 400 };
}

async function resolveProductSeo(
  shop: string,
  token: string,
  patch: Patch,
): Promise<Target | ResolveError> {
  const seoField = normalizeProductField(patch.field);
  if (!seoField) return { error: "invalid_field", status: 400 };

  const resolved = await fetchSeoProduct(shop, token, patch);
  if (resolved && "error" in resolved) return resolved;
  const product = resolved;
  if (!product) return { error: "target_not_found", status: 404 };

  const currentLive: string | null =
    seoField === "descriptionHtml"
      ? product.descriptionHtml
      : seoField === "seo.title"
        ? (product.seo?.title ?? null)
        : seoField === "seo.description"
          ? (product.seo?.description ?? null)
          : seoField === "title"
            ? product.title
            : seoField === "productType"
              ? product.productType
              : seoField === "vendor"
                ? product.vendor
                : (product.tags ?? []).join(", ");

  return {
    currentLive,
    write: async (newValue: string) => {
      const built =
        seoField === "descriptionHtml"
          ? { descriptionHtml: newValue }
          : seoField === "seo.title"
            ? { seo: { title: newValue } }
            : seoField === "seo.description"
              ? { seo: { description: newValue } }
              : seoField === "title"
                ? { title: newValue }
                : seoField === "productType"
                  ? { productType: newValue }
                  : seoField === "vendor"
                    ? { vendor: newValue }
                    : {
                        tags: newValue
                          .split(",")
                          .map((t) => t.trim())
                          .filter(Boolean),
                      };
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
      const userErrors = res.productUpdate?.userErrors ?? [];
      if (userErrors.length) return userErrors;

      // descriptionHtml is the field the reviewer found silently empty after
      // "Applied". Re-read it so a Shopify-side no-op (e.g. an app block or
      // sync overriding the write) surfaces as a real error instead of a
      // false success.
      if (seoField === "descriptionHtml" && newValue.trim() !== "") {
        const check = await shopifyGraphQL<{
          product: { descriptionHtml: string } | null;
        }>(
          shop,
          token,
          `query($id: ID!) { product(id: $id) { descriptionHtml } }`,
          { id: product.id },
        );
        if (!check.product?.descriptionHtml?.trim()) {
          return [
            {
              message:
                "L'ecriture n'a pas ete confirmee par Shopify, la description est restee vide. Reessayez.",
            },
          ];
        }
      }
      return [];
    },
  };
}

// product_compare_at: targetId is a variant gid. The bulk price mutation also
// needs the parent product id, so we read it from the variant.
type CompareAtVariant = {
  id: string;
  compareAtPrice: string | null;
  product: { id: string };
};

// Resolve the variant either by its GID or, as a fallback, by the product
// handle. When resolving by handle, only a single-variant product is
// unambiguous; several variants -> "variant_ambiguous".
async function fetchCompareAtVariant(
  shop: string,
  token: string,
  patch: Patch,
): Promise<CompareAtVariant | null | ResolveError> {
  if (isGid(patch.targetId)) {
    const data = await shopifyGraphQL<{
      productVariant: CompareAtVariant | null;
    }>(
      shop,
      token,
      `query($id: ID!) {
        productVariant(id: $id) {
          id compareAtPrice product { id }
        }
      }`,
      { id: patch.targetId },
    );
    return data.productVariant;
  }
  if (patch.targetHandle) {
    const data = await shopifyGraphQL<{
      products: {
        edges: {
          node: {
            id: string;
            variants: {
              edges: { node: { id: string; compareAtPrice: string | null } }[];
            };
          };
        }[];
      };
    }>(
      shop,
      token,
      `query($q: String!) {
        products(first: 1, query: $q) {
          edges {
            node {
              id
              variants(first: 100) {
                edges { node { id compareAtPrice } }
              }
            }
          }
        }
      }`,
      { q: `handle:${patch.targetHandle}` },
    );
    const node = data.products?.edges?.[0]?.node;
    if (!node) return null;
    const variants = node.variants?.edges ?? [];
    if (variants.length === 0) return null;
    if (variants.length > 1) return { error: "variant_ambiguous", status: 409 };
    const v = variants[0].node;
    return {
      id: v.id,
      compareAtPrice: v.compareAtPrice,
      product: { id: node.id },
    };
  }
  return { error: "missing_target_id", status: 400 };
}

async function resolveCompareAt(
  shop: string,
  token: string,
  patch: Patch,
): Promise<Target | ResolveError> {
  const resolved = await fetchCompareAtVariant(shop, token, patch);
  if (resolved && "error" in resolved) return resolved;
  const variant = resolved;
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

// policy / partial: shared resolver, both write the full body via
// shopPolicyUpdate ("partial" is used for absent/dummy/placeholder policies
// rewritten from real shop data, or an existing body with one paragraph
// appended - see auditEngine's system prompt). ShopPolicyInput only needs
// { type, body }, no existing id required, so shopPolicyUpdate also creates a
// policy of that type when it does not yet exist. targetId holds the type
// (e.g. REFUND_POLICY). patch.field for policy/partial is one of the policy
// type constants too (same value as targetId, per the tool schema's field
// enum) - it is not consulted here, only targetId is; the caller
// (app/api/fix/route.ts) maps it to the internal "policy_body" snapshot
// suffix for drift detection. A type absent from shop.shopPolicies is treated
// as an empty, writable policy - never an error - so the merchant can fill it
// in from scratch.
async function resolvePolicy(
  shop: string,
  token: string,
  patch: Patch,
): Promise<Target | ResolveError> {
  const type = patch.targetId;
  if (!type) return { error: "missing_policy_type", status: 400 };

  const data = await shopifyGraphQL<{
    shop: { shopPolicies: { id: string; type: string; body: string }[] };
  }>(shop, token, `{ shop { shopPolicies { id type body } } }`, {});

  const policy = (data.shop?.shopPolicies ?? []).find((p) => p.type === type);

  return {
    currentLive: policy?.body ?? "",
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
        { shopPolicy: { type, body: newValue } },
      );
      const userErrors = res.shopPolicyUpdate?.userErrors ?? [];
      if (userErrors.length) return userErrors;

      // Re-read the policy so it is only reported "Applied" once the Admin API
      // confirms the body actually matches what we just wrote.
      const check = await shopifyGraphQL<{
        shop: { shopPolicies: { type: string; body: string }[] };
      }>(shop, token, `{ shop { shopPolicies { type body } } }`, {});
      const written = (check.shop?.shopPolicies ?? []).find(
        (p) => p.type === type,
      );
      if (norm(written?.body) !== norm(newValue)) {
        return [
          {
            message:
              "L'ecriture n'a pas ete confirmee par Shopify, le contenu de la politique ne correspond pas. Reessayez.",
          },
        ];
      }
      return [];
    },
  };
}
