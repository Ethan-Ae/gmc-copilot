import crypto from "crypto";
import { getEnv, isValidShop } from "./shopify";

// A merchant installing from the Shopify App Store completes OAuth before they
// have any account here, so the shop row lands orphaned (user_id NULL). This
// cookie is the only link between that row and the account they create next.
// It is signed server-side: the merchant can delete it but cannot forge one
// pointing at someone else's shop.

export const PENDING_SHOP_COOKIE = "shopify_pending_claim";

// Short-lived on purpose: it only has to survive a sign-up.
export const PENDING_SHOP_TTL_SECONDS = 30 * 60;

function sign(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

// base64url keeps the payload free of "." so the separator stays unambiguous
// (shop domains contain dots).
export function signPendingShop(shop: string): string {
  const { apiSecret } = getEnv();
  const expiresAt = Date.now() + PENDING_SHOP_TTL_SECONDS * 1000;
  const payload = Buffer.from(JSON.stringify({ shop, expiresAt })).toString(
    "base64url",
  );
  return `${payload}.${sign(payload, apiSecret)}`;
}

// Returns the shop only for a cookie we signed ourselves, not expired, and
// still shaped like a Shopify domain. Any tampering returns null.
export function readPendingShop(raw: string | undefined): string | null {
  if (!raw) return null;

  const separator = raw.lastIndexOf(".");
  if (separator <= 0) return null;
  const payload = raw.slice(0, separator);
  const signature = raw.slice(separator + 1);

  let apiSecret: string;
  try {
    ({ apiSecret } = getEnv());
  } catch {
    return null;
  }

  const expected = sign(payload, apiSecret);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const { shop, expiresAt } = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as { shop?: unknown; expiresAt?: unknown };

    if (typeof shop !== "string" || typeof expiresAt !== "number") return null;
    if (Date.now() > expiresAt) return null;
    if (!isValidShop(shop)) return null;
    return shop;
  } catch {
    return null;
  }
}
