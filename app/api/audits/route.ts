import { NextRequest, after } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { jsonResponse } from "../../../lib/apiJson";
import { isValidShop } from "../../../lib/shopify";
import { getShopOwner } from "../../../lib/db";
import {
  getShopifyAccessToken,
  ShopifyReauthRequired,
} from "../../../lib/shopifyToken";
import {
  countAuditsForUserSince,
  createQueuedAudit,
  markAuditFailed,
} from "../../../lib/audits";
import { getEntitlements } from "../../../lib/entitlements";
import { limitsForPlan, startOfMonthUtc } from "../../../lib/plans";
import { runAuditForShop } from "../../../lib/auditEngine";

export const runtime = "nodejs";
export const maxDuration = 300;

// Starts an audit and returns immediately: the response is sent as soon as
// the quota row is reserved, but the actual Shopify + Claude work runs in the
// after() callback below, in the same invocation, so it survives past the
// response. An earlier version fired an unawaited fetch to
// POST /api/audits/[id]/run instead: on Vercel that request could be killed
// once this function returned, since nothing guaranteed the new invocation it
// triggered would actually run to completion. after() does not have that
// problem - Vercel keeps this invocation alive until the after() callback
// settles. POST /api/audits/[id]/run itself is kept as a manual fallback (it
// re-runs a still-queued row) but is no longer relied on for the normal path.
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

  // Fetched here both to fail fast with a clear error before reserving quota,
  // and to reuse for the after() audit run below instead of fetching it a
  // second time.
  let token: string;
  try {
    token = await getShopifyAccessToken(shop);
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

  // Run the audit itself after the response is sent, in this same
  // invocation. runAuditForShop already marks the row 'failed' on any
  // internal error; the catch here is a safety net for anything that could
  // throw before reaching that (e.g. a rejected promise from a bug), so the
  // row is never left stuck at 'queued'.
  after(async () => {
    try {
      await runAuditForShop({
        userId,
        shop,
        token,
        source: "manual",
        auditId,
      });
    } catch (err) {
      await markAuditFailed(
        auditId,
        err instanceof Error ? err.message : String(err),
      ).catch(() => {});
    }
  });

  return jsonResponse({ auditId, status: "queued" }, { status: 202 });
}
