import { neon } from "@neondatabase/serverless";
import { getEnv } from "./shopify";

// Single source of truth for reading a usable Shopify Admin API access token.
// Shopify stopped accepting non-expiring offline tokens, so this module migrates
// legacy tokens to expiring ones (access token ~1h + refresh token ~90d) via
// token exchange, then keeps them fresh by refreshing before expiry. All of this
// happens server-side without any merchant reinstall.

function db() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Missing DATABASE_URL env var");
  return neon(url);
}

// Raised when the 90-day refresh token is dead (invalid_grant) or no token is
// stored at all: the only recovery is to send the merchant back through OAuth.
export class ShopifyReauthRequired extends Error {
  readonly shop: string;
  constructor(shop: string, message?: string) {
    super(message ?? `Shopify re-authorization required for ${shop}`);
    this.name = "ShopifyReauthRequired";
    this.shop = shop;
  }
}

// Refresh a little before the real expiry so an in-flight request never races
// the boundary and hits Shopify with a just-expired token.
const REFRESH_SKEW_MS = 120_000;

type ShopTokenRow = {
  access_token: string;
  shopify_token_expires_at: string | null;
  shopify_refresh_token: string | null;
  shopify_refresh_token_expires_at: string | null;
};

type TokenResponse = {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
};

// One in-flight migration/refresh per shop. Two concurrent refreshes would each
// rotate the refresh token and invalidate the other, so the second caller waits
// on the first and reuses its result. In-memory is enough: a single Vercel
// lambda instance handles the burst of requests that share a token.
const inflight = new Map<string, Promise<string>>();

export async function getShopifyAccessToken(shopDomain: string): Promise<string> {
  const shop = shopDomain.trim().toLowerCase();

  const row = await readRow(shop);
  if (!row) {
    throw new ShopifyReauthRequired(shop, `No Shopify token stored for ${shop}`);
  }

  // Case B: an expiring token that is still comfortably valid.
  if (isFresh(row)) return row.access_token;

  // Case A (legacy) or Case C (expired/near expiry) both need a network call.
  const existing = inflight.get(shop);
  if (existing) return existing;

  const p = migrateOrRefresh(shop).finally(() => inflight.delete(shop));
  inflight.set(shop, p);
  return p;
}

function isFresh(row: ShopTokenRow): boolean {
  // A legacy non-expiring token has no refresh token: force migration.
  if (!row.shopify_refresh_token || !row.shopify_token_expires_at) return false;
  const expiresAt = new Date(row.shopify_token_expires_at).getTime();
  return expiresAt > Date.now() + REFRESH_SKEW_MS;
}

async function migrateOrRefresh(shop: string): Promise<string> {
  // Re-read under the lock: another request may have refreshed while we queued.
  const row = await readRow(shop);
  if (!row) {
    throw new ShopifyReauthRequired(shop, `No Shopify token stored for ${shop}`);
  }
  if (isFresh(row)) return row.access_token;

  const { apiKey, apiSecret } = getEnv();

  const body = new URLSearchParams({ client_id: apiKey, client_secret: apiSecret });
  if (!row.shopify_refresh_token) {
    // Case A: legacy non-expiring token -> token exchange into an expiring one.
    // This revokes the old non-expiring token: irreversible and intended.
    body.set("grant_type", "urn:ietf:params:oauth:grant-type:token-exchange");
    body.set("subject_token", row.access_token);
    body.set(
      "subject_token_type",
      "urn:shopify:params:oauth:token-type:offline-access-token",
    );
    body.set(
      "requested_token_type",
      "urn:shopify:params:oauth:token-type:offline-access-token",
    );
    body.set("expiring", "1");
  } else {
    // Case C: expiring token expired or within the skew -> refresh it.
    body.set("grant_type", "refresh_token");
    body.set("refresh_token", row.shopify_refresh_token);
  }

  const tok = await callTokenEndpoint(shop, body);
  return persistRefreshed(shop, tok);
}

async function callTokenEndpoint(
  shop: string,
  body: URLSearchParams,
): Promise<TokenResponse> {
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  const text = await res.text();
  if (!res.ok) {
    // A dead refresh token (or a revoked legacy token) reports invalid_grant.
    if (/invalid_grant/.test(text)) {
      throw new ShopifyReauthRequired(
        shop,
        `Shopify token endpoint returned invalid_grant for ${shop}`,
      );
    }
    throw new Error(
      `Shopify token endpoint failed for ${shop} (${res.status}): ${text}`,
    );
  }

  const tok = JSON.parse(text) as TokenResponse;
  if (!tok.access_token) {
    throw new Error(`Shopify token endpoint returned no access_token for ${shop}`);
  }
  return tok;
}

function expiryIso(seconds: number | undefined): string | null {
  return typeof seconds === "number"
    ? new Date(Date.now() + seconds * 1000).toISOString()
    : null;
}

async function readRow(shop: string): Promise<ShopTokenRow | null> {
  const sql = db();
  const rows = (await sql`
    select access_token,
           shopify_token_expires_at,
           shopify_refresh_token,
           shopify_refresh_token_expires_at
    from shops
    where shop = ${shop}
  `) as ShopTokenRow[];
  return rows.length ? rows[0] : null;
}

// Persist the new token pair in a single atomic UPDATE. coalesce guards the
// refresh token/expiry so a response that omits them keeps the stored pair
// instead of nulling it.
async function persistRefreshed(shop: string, tok: TokenResponse): Promise<string> {
  const accessIso = expiryIso(tok.expires_in);
  const refreshIso = expiryIso(tok.refresh_token_expires_in);
  const sql = db();
  await sql`
    update shops set
      access_token = ${tok.access_token},
      shopify_token_expires_at = ${accessIso},
      shopify_refresh_token = coalesce(${tok.refresh_token ?? null}, shopify_refresh_token),
      shopify_refresh_token_expires_at = coalesce(${refreshIso}, shopify_refresh_token_expires_at),
      updated_at = now()
    where shop = ${shop}
  `;
  return tok.access_token;
}

// Upsert used by the OAuth callback after the authorization-code exchange, where
// the row may not exist yet and we also need to set scope/user_id.
export async function persistOAuthTokens(
  shop: string,
  scope: string | null,
  userId: string | null,
  tok: TokenResponse,
): Promise<void> {
  const accessIso = expiryIso(tok.expires_in);
  const refreshIso = expiryIso(tok.refresh_token_expires_in);
  const sql = db();
  await sql`
    insert into shops (
      shop, access_token, scope, user_id,
      shopify_token_expires_at, shopify_refresh_token, shopify_refresh_token_expires_at,
      updated_at
    )
    values (
      ${shop}, ${tok.access_token}, ${scope}, ${userId},
      ${accessIso}, ${tok.refresh_token ?? null}, ${refreshIso},
      now()
    )
    on conflict (shop) do update set
      access_token = excluded.access_token,
      scope = excluded.scope,
      user_id = coalesce(excluded.user_id, shops.user_id),
      shopify_token_expires_at = excluded.shopify_token_expires_at,
      shopify_refresh_token = excluded.shopify_refresh_token,
      shopify_refresh_token_expires_at = excluded.shopify_refresh_token_expires_at,
      updated_at = now()
  `;
}
