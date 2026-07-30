import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { jsonResponse } from "../../../lib/apiJson";
import { isValidShop } from "../../../lib/shopify";
import { getShopOwner } from "../../../lib/db";
import {
  getShopifyAccessToken,
  ShopifyReauthRequired,
} from "../../../lib/shopifyToken";
import { countAuditsForUserSince } from "../../../lib/audits";
import {
  runAuditForShop,
  MissingAnthropicKey,
  ModelNoToolBlock,
} from "../../../lib/auditEngine";
import { getEntitlements } from "../../../lib/entitlements";
import { limitsForPlan, startOfMonthUtc } from "../../../lib/plans";

export const runtime = "nodejs";
export const maxDuration = 60;

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

  try {
    const result = await runAuditForShop({
      userId,
      shop,
      token,
      source: "manual",
    });

    return jsonResponse({
      shop,
      model: result.model,
      truncated: result.truncated,
      audit: result.audit,
      entitlements: {
        canFullAudit: entitlements.canFullAudit,
        canApplyFixes: entitlements.canApplyFixes,
        source: entitlements.source,
      },
    });
  } catch (err) {
    if (err instanceof MissingAnthropicKey) {
      return jsonResponse({ error: err.message }, { status: 500 });
    }
    if (err instanceof ModelNoToolBlock) {
      return jsonResponse(
        { error: err.message, stop_reason: err.stopReason },
        { status: 502 },
      );
    }
    return jsonResponse(
      { error: "Anthropic API call failed", detail: String(err) },
      { status: 502 },
    );
  }
}
