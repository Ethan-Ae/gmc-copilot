import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { jsonResponse } from "../../../lib/apiJson";
import { isValidShop } from "../../../lib/shopify";
import { getShopOwner } from "../../../lib/db";
import {
  getShopifyAccessToken,
  ShopifyReauthRequired,
} from "../../../lib/shopifyToken";
import { getEntitlements } from "../../../lib/entitlements";
import { recordFix } from "../../../lib/fixHistory";
import { getAuditById, updateFieldSnapshot } from "../../../lib/audits";
import {
  APPLICABLE_FIX_TYPES,
  norm,
  resolveTarget,
  type Mode,
  type Patch,
} from "../../../lib/shopifyFix";

export const runtime = "nodejs";
export const maxDuration = 30;

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

  // (b bis) The whole fix workflow - preview and apply - is gated on the shop's
  // full-access entitlement (active one-time charge, or legacy pro).
  // canApplyFixes is true only for those sources, so an expired or never-paid
  // shop is refused here: no Shopify read-back or write can happen without
  // active full access. Audits keep their own free quota and are unaffected.
  const entitlements = await getEntitlements(userId, shop);
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

  // (c) fixType allowlist. autoApplicable is deliberately ignored here.
  const fixType = patch.fixType ?? "";
  if (!APPLICABLE_FIX_TYPES.has(fixType)) {
    return jsonResponse({ error: "fix_type_not_applicable" }, { status: 403 });
  }

  let token: string;
  try {
    token = await getShopifyAccessToken(shop);
  } catch (err) {
    if (err instanceof ShopifyReauthRequired) {
      return jsonResponse({ error: "shopify_reauth_required" }, { status: 401 });
    }
    return jsonResponse({ error: "shopify_token_error" }, { status: 502 });
  }

  const newValue = patch.newValue ?? "";

  // The audit-time baseline for drift detection. Prefer the real value read
  // straight from the Admin API when the audit reserved one (auditEngine's
  // field_snapshots), since patch.currentValue is Claude's transcription of
  // that value and is not guaranteed byte-exact for long HTML - relying on it
  // alone caused spurious "modified since the audit" drift on a first-ever
  // apply. Falls back to patch.currentValue for older audits or fields not
  // snapshotted (e.g. policy_body).
  let capturedValue = patch.currentValue ?? "";
  let snapshotKey: string | null = null;
  if (body.auditId && patch.targetId && patch.field) {
    const auditRow = await getAuditById(body.auditId, userId).catch(() => null);
    const key = `${patch.targetId}|${patch.field}`;
    const snapshots = auditRow?.field_snapshots;
    if (snapshots && Object.prototype.hasOwnProperty.call(snapshots, key)) {
      snapshotKey = key;
      capturedValue = snapshots[key];
    }
  }

  try {
    // Resolve the target and read its live value.
    const target = await resolveTarget(shop, token, fixType, patch);
    if ("error" in target) {
      return jsonResponse({ error: target.error }, { status: target.status });
    }

    const { currentLive } = target;
    const drift = norm(currentLive) !== norm(capturedValue);

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
        capturedValue,
        newValue,
        drift: true,
      });
    }

    // apply, no drift: write, then historise so it can be reverted.
    const userErrors = await target.write(newValue);
    if (userErrors.length) {
      return jsonResponse({ status: "error", userErrors }, { status: 502 });
    }

    // Keep the snapshot fresh so a second fix on the same field within the
    // same audit (e.g. a retried "Tout corriger" batch) compares against what
    // we just wrote, not the stale audit-time value.
    if (body.auditId && snapshotKey) {
      await updateFieldSnapshot(body.auditId, snapshotKey, newValue).catch(() => {});
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
    return jsonResponse({ status: "error", detail: String(err) }, { status: 502 });
  }
}
