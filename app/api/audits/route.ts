import { NextRequest, after } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { jsonResponse } from "../../../lib/apiJson";
import { isValidShop } from "../../../lib/shopify";
import { getShopOwner } from "../../../lib/db";
import {
  getShopifyAccessToken,
  ShopifyReauthRequired,
} from "../../../lib/shopifyToken";
import { countAuditsForUserSince, createQueuedAudit } from "../../../lib/audits";
import { getEntitlements } from "../../../lib/entitlements";
import { limitsForPlan, startOfMonthUtc } from "../../../lib/plans";

export const runtime = "nodejs";
export const maxDuration = 15;

// Starts an audit and returns immediately: the actual Shopify + Claude work
// happens in POST /api/audits/[id]/run, which has its own 300s budget. This
// route only has to validate, reserve the quota row, and hand off - so it
// never risks the 504 the previous synchronous /api/audit route could hit on
// a slow or large store.
export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return jsonResponse({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { shop?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }
  const shop =
    (body.shop ?? req.nextUrl.searchParams.get("shop"))
      ?.trim()
      .toLowerCase() ?? "";
  if (!shop || !isValidShop(shop)) {
    return jsonResponse({ error: "Invalid shop" }, { status: 400 });
  }

  // The shop must belong to the signed-in user before we read or audit it.
  const owner = await getShopOwner(shop);
  if (owner !== userId) {
    return jsonResponse({ error: "Forbidden" }, { status: 403 });
  }

  // Resolve entitlements (Shopify Billing on the shop, then legacy pro, then
  // free). Full rights get the pro monthly quota; free keeps the free quota so
  // the existing per-month counting is unchanged.
  const entitlements = await getEntitlements(userId, shop);
  const limits = limitsForPlan(entitlements.canFullAudit ? "pro" : "free");
  const used = await countAuditsForUserSince(userId, startOfMonthUtc());
  if (used >= limits.auditsPerMonth) {
    return jsonResponse(
      {
        error: "audit_limit_reached",
        source: entitlements.source,
        used,
        limit: limits.auditsPerMonth,
      },
      { status: 402 },
    );
  }

  // The token is fetched here only to fail fast with a clear error before
  // reserving quota. The worker route re-fetches it itself rather than
  // carrying it over the wire.
  try {
    await getShopifyAccessToken(shop);
  } catch (err) {
    if (err instanceof ShopifyReauthRequired) {
      return jsonResponse(
        { error: "Shopify re-authorization required. Reconnect the app." },
        { status: 401 },
      );
    }
    return jsonResponse(
      { error: "Could not obtain a Shopify access token." },
      { status: 502 },
    );
  }

  // Reserve the quota row now, before any Claude call, exactly like the
  // previous synchronous flow did right before the paid call.
  const auditId = await createQueuedAudit(userId, shop, "manual");

  const secret = process.env.AUDIT_WORKER_SECRET;
  const runUrl = new URL(`/api/audits/${auditId}/run`, req.nextUrl.origin);

  const trigger = () =>
    fetch(runUrl, {
      method: "POST",
      headers: secret ? { Authorization: `Bearer ${secret}` } : {},
    }).catch(() => {
      // The worker route itself marks the row 'failed' on any internal error.
      // A failure to even reach it here is surfaced to the merchant only
      // through the poll timing out; nothing else to do with the response.
    });

  // after() keeps this function alive just long enough to fire the request to
  // the worker route, without extending this route's own maxDuration - the
  // actual audit work happens in that separate, longer-lived invocation.
  after(trigger);

  return jsonResponse({ auditId, status: "queued" }, { status: 202 });
}
