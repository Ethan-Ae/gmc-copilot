import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { jsonResponse } from "../../../lib/apiJson";
import { getShopifyAppStoreUrl, isValidShop } from "../../../lib/shopify";
import { getShopOwner } from "../../../lib/db";
import {
  getShopifyAccessToken,
  ShopifyReauthRequired,
} from "../../../lib/shopifyToken";
import { getEntitlements, oneTimeAccessExpired } from "../../../lib/entitlements";
import { getBillingState } from "../../../lib/billingState";
import { recordFix } from "../../../lib/fixHistory";
import { getAuditById, updateFieldSnapshot } from "../../../lib/audits";
import {
  APPLICABLE_FIX_TYPES,
  norm,
  resolveErrorMessage,
  resolveTarget,
  type Mode,
  type Patch,
  type UserError,
} from "../../../lib/shopifyFix";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_MULTI_TARGETS = 50;

// Same route UnlockButton already posts to (app/report/ReportClient.tsx) -
// kept here as the single literal so a client never has to guess it.
const BILLING_START_URL = "/api/shopify/billing/start";

// A clicked "Appliquer" must never surface a raw 4xx/5xx to the merchant (App
// Review 2.1.1 reviewer hit a blocking 403 on a no-purchase account). Every
// product-state outcome below - unpaid, expired, dead token, or a genuine
// write failure - is reported as a 200 with a status the client renders as a
// banner or redirect, never as an HTTP error.
function okJson(body: unknown) {
  return jsonResponse(body);
}

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
    // Never paid vs. the 30-day window having lapsed get distinct wording so
    // the merchant knows whether this is their first purchase or a renewal.
    const billing = await getBillingState(shop);
    const expired = oneTimeAccessExpired(billing);
    return okJson({
      status: "payment_required",
      billingUrl: BILLING_START_URL,
      message: expired
        ? "Votre accès de 30 jours est terminé. Relancez une mise en conformité pour appliquer ce correctif."
        : "Les corrections automatiques sont incluses dans la mise en conformité. Débloquez l'accès pour appliquer ce correctif.",
    });
  }

  // (c) fixType allowlist. autoApplicable is deliberately ignored here.
  const fixType = patch.fixType ?? "";
  if (!APPLICABLE_FIX_TYPES.has(fixType)) {
    return okJson({
      status: "failed",
      code: "fix_type_not_applicable",
      message: resolveErrorMessage("fix_type_not_applicable"),
    });
  }

  let token: string;
  try {
    token = await getShopifyAccessToken(shop);
  } catch (err) {
    if (err instanceof ShopifyReauthRequired) {
      console.warn(`[fix:shopify_reauth_required] shop=${shop}`);
      let reauthUrl: string;
      try {
        reauthUrl = getShopifyAppStoreUrl();
      } catch (envErr) {
        console.error(`[fix:shopify_reauth_required] missing app store url`, envErr);
        return okJson({
          status: "failed",
          code: "shopify_reauth_required",
          message:
            "La connexion à Shopify a expiré. Réinstallez l'app depuis le Shopify App Store pour la rétablir.",
        });
      }
      return okJson({ status: "reauth_required", reauthUrl });
    }
    console.error(`[fix:shopify_token_error] shop=${shop}`, err);
    return okJson({
      status: "failed",
      code: "shopify_token_error",
      message: "La connexion à Shopify a échoué. Réessayez.",
    });
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
      return okJson({
        status: "failed",
        code: target.error,
        message: resolveErrorMessage(target.error),
      });
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
      console.warn(`[fix:write_failed] shop=${shop} fixType=${fixType}`, userErrors);
      return okJson({
        status: "failed",
        code: "write_failed",
        message:
          "Shopify a refusé cette modification. Corrigez-la manuellement dans l'admin Shopify ou réessayez.",
      });
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
    // Log the raw detail server-side only; the client never sees exception
    // text, just a fixed French message (same convention as auditErrors.ts).
    console.error(`[fix:single] shop=${shop}`, err);
    return okJson({
      status: "failed",
      code: "internal_error",
      message: "Une erreur technique est survenue. Réessayez.",
    });
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
    return okJson({
      status: "failed",
      code: "missing_target_id",
      message: resolveErrorMessage("missing_target_id"),
    });
  }
  if (!findText) {
    return okJson({
      status: "failed",
      code: "missing_find_text",
      message: "Le texte à remplacer est manquant.",
    });
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
      console.error(`[fix:multi] shop=${shop} targetId=${targetId}`, err);
      skipped.push({ targetId, reason: "Une erreur technique est survenue." });
      continue;
    }
    if ("error" in target) {
      console.warn(`[fix:multi:${target.error}] shop=${shop} targetId=${targetId}`);
      skipped.push({ targetId, reason: resolveErrorMessage(target.error) });
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
      skipped.push({ targetId, reason: "Phrase déjà absente de ce produit." });
      continue;
    }
    if (drift) {
      console.warn(
        `[fix:multi:drift] shop=${shop} targetId=${targetId} snapshotKey=${key} ` +
          `captured=${JSON.stringify(capturedValue).slice(0, 500)} live=${JSON.stringify(currentLive).slice(0, 500)}`,
      );
      skipped.push({ targetId, reason: "Modifié depuis l'audit - relancez un audit." });
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

  const targetCount = targetIds.length;

  if (mode === "preview") {
    return jsonResponse({
      status: "preview",
      multi: true,
      targetCount,
      results: previewRows,
    });
  }

  // Never report "applied" when nothing was actually written: a multi-product
  // find/replace that finds its text in zero products (e.g. every
  // descriptionHtml snapshot was empty) must not look like a success.
  if (appliedCount === 0) {
    console.warn(`[fix:multi:nothing_applied] shop=${shop} targetCount=${targetCount}`, skipped);
    return okJson({
      status: "failed",
      code: "nothing_applied",
      multi: true,
      message:
        "Aucune modification appliquée : le texte à corriger est absent de ces produits. Relancez l'audit.",
      skipped,
    });
  }

  if (appliedCount < targetCount) {
    return jsonResponse({
      status: "partial",
      multi: true,
      appliedCount,
      skippedCount: skipped.length,
      skipped,
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
