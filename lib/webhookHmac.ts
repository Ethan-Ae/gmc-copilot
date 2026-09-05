// Shared Shopify webhook HMAC verification. Every webhook route must call
// this on the raw (unparsed) request body before doing anything else - an
// invalid signature is the only case that should ever produce a non-200
// response from a webhook handler (Shopify retries everything else).
import crypto from "crypto";

export function verifyWebhookHmac(rawBody: string, header: string | null): boolean {
  if (!header) return false;
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) return false;

  const digest = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");

  const a = Buffer.from(digest, "utf8");
  const b = Buffer.from(header, "utf8");
  // Length check first: timingSafeEqual throws on mismatched lengths.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
