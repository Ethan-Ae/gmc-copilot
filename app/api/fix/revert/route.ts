import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { jsonResponse } from "../../../../lib/apiJson";
import {
  getShopifyAccessToken,
  ShopifyReauthRequired,
} from "../../../../lib/shopifyToken";
import { getFixById, markReverted } from "../../../../lib/fixHistory";
import { getEntitlements } from "../../../../lib/entitlements";
import { norm, resolveTarget, type Patch } from "../../../../lib/shopifyFix";

export const runtime = "nodejs";
export const maxDuration = 30;

// Undo a previously applied fix: write the recorded previous_value back into the
// same field. The fix row is looked up scoped to the signed-in user, so a user
// can only revert their own changes. If the live value no longer matches what we
// wrote (new_value), the field drifted again since we applied it: refuse rather
// than clobber a fresh manual change.
export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return jsonResponse({ error: "unauthorized" }, { status: 401 });
  }

  let body: { fixHistoryId?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonResponse({ error: "invalid_json" }, { status: 400 });
  }

  const id = body.fixHistoryId?.trim();
  if (!id) {
    return jsonResponse({ error: "missing_fix_history_id" }, { status: 400 });
  }

  const fix = await getFixById(id, userId);
  if (!fix) {
    return jsonResponse({ error: "not_found" }, { status: 404 });
  }

  // Undo writes previous_value back into Shopify, so it is a Shopify write and
  // must sit behind the same full-access gate as apply. An expired shop cannot
  // mutate the store (even to roll a change back) until it re-runs a compliance.
  const entitlements = await getEntitlements(userId, fix.shop);
  if (!entitlements.canApplyFixes) {
    return jsonResponse(
      {
        error: "acces_expire",
        message:
          "Votre acces est expire. Relancez une mise en conformite pour appliquer des correctifs.",
      },
      { status: 403 },
    );
  }

  if (fix.reverted_at) {
    return jsonResponse({ error: "already_reverted" }, { status: 409 });
  }

  let token: string;
  try {
    token = await getShopifyAccessToken(fix.shop);
  } catch (err) {
    if (err instanceof ShopifyReauthRequired) {
      return jsonResponse({ error: "shopify_reauth_required" }, { status: 401 });
    }
    return jsonResponse({ error: "shopify_token_error" }, { status: 502 });
  }

  // Rebuild the patch to write previous_value back into the same target.
  const patch: Patch = {
    fixType: fix.fix_type,
    field: fix.field,
    targetId: fix.target_id,
    currentValue: fix.new_value ?? "",
    newValue: fix.previous_value ?? "",
  };

  try {
    const target = await resolveTarget(fix.shop, token, fix.fix_type, patch);
    if ("error" in target) {
      return jsonResponse({ error: target.error }, { status: target.status });
    }

    // Anti-drift: the live value must still be what we wrote. Otherwise the
    // merchant changed it again and we would clobber that change.
    const drift = norm(target.currentLive) !== norm(fix.new_value ?? "");
    if (drift) {
      return jsonResponse({
        status: "drift",
        currentLive: target.currentLive,
        capturedValue: fix.new_value ?? "",
        drift: true,
      });
    }

    const userErrors = await target.write(fix.previous_value ?? "");
    if (userErrors.length) {
      return jsonResponse({ status: "error", userErrors }, { status: 502 });
    }

    await markReverted(id, userId);

    return jsonResponse({
      status: "reverted",
      restoredValue: fix.previous_value,
    });
  } catch (err) {
    return jsonResponse({ status: "error", detail: String(err) }, { status: 502 });
  }
}
