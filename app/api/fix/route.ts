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
  type UserError,
} from "../../../lib/shopifyFix";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_MULTI_TARGETS = 50;

// The second half of the field_snapshots key (see lib/auditEngine.ts's
// fieldSnapshots) does not always equal the wire "field" the model sends: for
// policy/partial the wire field is one of the policy type constants (matching
// targetId, per the tool schema's field enum), but auditEngine always
// snapshots policies under the fixed suffix "policy_body". Translating here
// keeps the two in sync without coupling the tool schema to the internal
// snapshot key format.
function snapshotFieldFor(fixType: string, field: string | null | undefined): string | null {
  if (fixType === "policy" || fixType === "partial") return "policy_body";
  return field ?? null;
}

// A Shopify Admin GID, e.g. gid://shopify/Product/123.
function isGid(s: unknown): s is string {
  return typeof s === "string" && /^gid:\/\/shopify\/\w+\/\d+/.test(s);
}

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

  // Multi-product fix: the same literal phrase is removed/replaced across
  // several products in one call instead of one patch per product.
  if (
    fixType === "product_seo" &&
    patch.field === "descriptionHtml" &&
    Array.isArray(patch.targetIds) &&
    patch.targetIds.length > 0
  ) {
    return handleMultiTarget({ userId, shop, token, patch, mode, auditId: body.auditId });
  }

  const newValue = patch.newValue ?? "";

  // The audit-time baseline for drift detection. Prefer the real value read
  // straight from the Admin API when the audit reserved one (auditEngine's
  // field_snapshots), since patch.currentValue is Claude's transcription of
  // that value and is not guaranteed byte-exact for long HTML - relying on it
  // alone caused spurious "modified since the audit" drift on a first-ever
  // apply. When no snapshot exists at all for this exact key (older audit
  // whose row predates field_snapshots, or a field genuinely never captured),
  // there is nothing trustworthy to compare against - skip the drift check
  // entirely and apply, rather than falsely refuse against Claude's
  // transcription of "currentValue".
  let capturedValue = patch.currentValue ?? "";
  let snapshotKey: string | null = null;
  let hasSnapshot = false;
  const snapshotField = snapshotFieldFor(fixType, patch.field);
  if (body.auditId && patch.targetId && snapshotField) {
    const auditRow = await getAuditById(body.auditId, userId).catch(() => null);
    const key = `${patch.targetId}|${snapshotField}`;
    const snapshots = auditRow?.field_snapshots;
    if (snapshots && Object.prototype.hasOwnProperty.call(snapshots, key)) {
      snapshotKey = key;
      capturedValue = snapshots[key];
      hasSnapshot = true;
    }
  }

  try {
    // Resolve the target and read its live value.
    const target = await resolveTarget(shop, token, fixType, patch);
    if ("error" in target) {
      console.warn(
        `[fix:${target.error}] shop=${shop} fixType=${fixType} field=${JSON.stringify(patch.field ?? null)} targetId=${patch.targetId ?? "null"}`,
      );
      return jsonResponse({ error: target.error }, { status: target.status });
    }

    const { currentLive } = target;
    const stripTags = patch.field === "descriptionHtml";
    const drift =
      hasSnapshot && norm(currentLive, { stripTags }) !== norm(capturedValue, { stripTags });

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
      console.warn(
        `[fix:drift] shop=${shop} fixType=${fixType} field=${JSON.stringify(patch.field ?? null)} ` +
          `targetId=${patch.targetId ?? "null"} snapshotKey=${snapshotKey} ` +
          `captured=${JSON.stringify(capturedValue).slice(0, 500)} live=${JSON.stringify(currentLive).slice(0, 500)}`,
      );
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

// Applies (or previews) the same find/replace transformation to every product
// in patch.targetIds, each resolved and drift-checked independently via the
// normal single-product machinery, so an issue like "this exact promo phrase
// appears in ~40 product descriptions" is one user action instead of 40.
async function handleMultiTarget(opts: {
  userId: string;
  shop: string;
  token: string;
  patch: Patch;
  mode: Mode;
  auditId?: string;
}) {
  const { userId, shop, token, patch, mode, auditId } = opts;
  const targetIds = (patch.targetIds ?? []).filter(isGid).slice(0, MAX_MULTI_TARGETS);
  const findText = patch.findText ?? "";
  const replaceText = patch.replaceText ?? "";

  if (targetIds.length === 0) {
    return jsonResponse({ error: "missing_target_id" }, { status: 400 });
  }
  if (!findText) {
    return jsonResponse({ error: "missing_find_text" }, { status: 400 });
  }

  const auditRow = auditId ? await getAuditById(auditId, userId).catch(() => null) : null;
  const snapshots = auditRow?.field_snapshots ?? null;

  type PreviewRow = {
    targetId: string;
    found: boolean;
    currentLive: string | null;
    newValue: string | null;
    drift: boolean;
  };
  type SkippedRow = { targetId: string; reason: string };

  const previewRows: PreviewRow[] = [];
  const skipped: SkippedRow[] = [];
  let appliedCount = 0;

  for (const targetId of targetIds) {
    const targetPatch: Patch = { fixType: "product_seo", field: "descriptionHtml", targetId };
    let target;
    try {
      target = await resolveTarget(shop, token, "product_seo", targetPatch);
    } catch (err) {
      skipped.push({ targetId, reason: String(err) });
      continue;
    }
    if ("error" in target) {
      console.warn(`[fix:multi:${target.error}] shop=${shop} targetId=${targetId}`);
      skipped.push({ targetId, reason: target.error });
      continue;
    }

    const { currentLive } = target;
    const found = typeof currentLive === "string" && currentLive.includes(findText);
    const computedValue = found
      ? (currentLive as string).split(findText).join(replaceText).replace(/[ \t]{2,}/g, " ").trim()
      : currentLive;

    const key = `${targetId}|descriptionHtml`;
    const hasSnapshot = Boolean(snapshots && Object.prototype.hasOwnProperty.call(snapshots, key));
    const capturedValue = hasSnapshot ? snapshots![key] : "";
    const drift =
      hasSnapshot && norm(currentLive, { stripTags: true }) !== norm(capturedValue, { stripTags: true });

    if (mode === "preview") {
      previewRows.push({ targetId, found, currentLive, newValue: computedValue, drift });
      continue;
    }

    if (!found) {
      skipped.push({ targetId, reason: "Phrase deja absente de ce produit." });
      continue;
    }
    if (drift) {
      console.warn(
        `[fix:multi:drift] shop=${shop} targetId=${targetId} snapshotKey=${key} ` +
          `captured=${JSON.stringify(capturedValue).slice(0, 500)} live=${JSON.stringify(currentLive).slice(0, 500)}`,
      );
      skipped.push({ targetId, reason: "Modifie depuis l'audit - relancez un audit." });
      continue;
    }

    const userErrors: UserError[] = await target.write(computedValue ?? "");
    if (userErrors.length) {
      skipped.push({ targetId, reason: userErrors.map((e) => e.message).join(" ") });
      continue;
    }

    if (auditId) {
      await updateFieldSnapshot(auditId, key, computedValue ?? "").catch(() => {});
    }
    await recordFix({
      userId,
      shop,
      auditId: auditId ?? null,
      fixType: "product_seo",
      field: "descriptionHtml",
      targetId,
      previousValue: currentLive,
      newValue: computedValue,
    });
    appliedCount += 1;
  }

  if (mode === "preview") {
    return jsonResponse({
      status: "preview",
      multi: true,
      targetCount: targetIds.length,
      results: previewRows,
    });
  }

  return jsonResponse({
    status: "applied",
    multi: true,
    appliedCount,
    skippedCount: skipped.length,
    skipped,
  });
}
