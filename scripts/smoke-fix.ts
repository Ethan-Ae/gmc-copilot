// Manual smoke test for the fix-apply pipeline, in particular the two
// regressions this change fixes: false "drift" on a fix's first-ever apply,
// and "invalid_field" on freshly generated audits (see lib/shopifyFix.ts and
// app/api/fix/route.ts). Runs a real audit against a real dev store, then
// applies every auto-applicable fix - single-product and multi-product -
// through the same pure logic app/api/fix/route.ts uses, bypassing only the
// Clerk/HTTP/entitlements layer (no session available from a script), same
// approach as scripts/smoke-audit.ts. Exits non-zero if any fix is skipped
// for "drift" or "invalid_field": those are exactly the regressions this
// change must prevent from reappearing.
//
// Usage: npx tsx scripts/smoke-fix.ts <shop>.myshopify.com

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Patch } from "../lib/shopifyFix";

// tsx does not load .env.local the way Next.js does, so read it manually.
function loadEnvLocal(): void {
  const path = resolve(process.cwd(), ".env.local");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvLocal();

type SmokeIssue = {
  problem?: string;
  product?: string | null;
  patch?: Patch | null;
};

const USER_ID = "smoke-test";

function isGid(s: unknown): s is string {
  return typeof s === "string" && /^gid:\/\/shopify\/\w+\/\d+/.test(s);
}

async function main(): Promise<void> {
  const shop = process.argv[2]?.trim().toLowerCase();
  if (!shop) {
    console.error("Usage: npx tsx scripts/smoke-fix.ts <shop>.myshopify.com");
    process.exitCode = 1;
    return;
  }

  const { getShopifyAccessToken, ShopifyReauthRequired } = await import(
    "../lib/shopifyToken"
  );
  const { runAuditForShop } = await import("../lib/auditEngine");
  const { getAuditById, updateFieldSnapshot } = await import("../lib/audits");
  const { recordFix } = await import("../lib/fixHistory");
  const { resolveTarget, norm, snapshotFieldFor } = await import(
    "../lib/shopifyFix"
  );

  console.log(`[smoke] shop=${shop}`);
  console.log("[smoke] fetching Shopify access token...");

  let token: string;
  try {
    token = await getShopifyAccessToken(shop);
  } catch (err) {
    if (err instanceof ShopifyReauthRequired) {
      console.error(
        `[smoke] FAIL: no usable Shopify token for ${shop}. Connect the app to this store first.`,
      );
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  console.log("[smoke] token OK");

  console.log("[smoke] running audit (can take a few minutes on a large store)...");
  const started = Date.now();
  const result = await runAuditForShop({
    userId: USER_ID,
    shop,
    token,
    source: "manual",
    onProgress: async (step) => {
      console.log(`[smoke] progress: ${step}`);
    },
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `[smoke] audit done in ${seconds}s - overall=${result.overall} auditId=${result.auditId} ` +
      `products=${result.productsAudited}${
        result.productsTotal != null ? `/${result.productsTotal}` : ""
      } truncated=${result.truncated} gmcConnected=${result.gmcConnected} ` +
      `needsReauth=${result.needsReauth}`,
  );

  if (result.warnings.length) {
    console.log(`[smoke] ${result.warnings.length} warning(s) during the audit:`);
    for (const w of result.warnings) console.log(`  - ${w}`);
  }

  // Re-read the audit row so the drift check below compares against exactly
  // what app/api/fix/route.ts would see (field_snapshots persisted by
  // markAuditDone), not the in-memory result.
  const auditRow = await getAuditById(result.auditId, USER_ID);
  if (!auditRow) {
    console.error(
      "[smoke] FATAL: could not re-read the just-created audit row (field_snapshots unavailable).",
    );
    process.exitCode = 1;
    return;
  }
  let snapshots: Record<string, string> = auditRow.field_snapshots ?? {};

  const issues = (result.audit.issues as SmokeIssue[] | undefined) ?? [];
  console.log(`[smoke] ${issues.length} issue(s) reported`);

  const autoIssues = issues.filter(
    (i): i is SmokeIssue & { patch: Patch } => Boolean(i.patch?.autoApplicable),
  );
  console.log(`[smoke] ${autoIssues.length} auto-applicable fix(es) to try`);

  let applied = 0;
  let skipped = 0;
  let errored = 0;
  let driftSkips = 0;
  let invalidFieldSkips = 0;

  for (const issue of autoIssues) {
    const patch = issue.patch;
    const isMulti =
      patch.fixType === "product_seo" &&
      patch.field === "descriptionHtml" &&
      Array.isArray(patch.targetIds) &&
      patch.targetIds.length > 0;

    if (isMulti) {
      const targetIds = (patch.targetIds ?? []).filter(isGid);
      const findText = patch.findText ?? "";
      const replaceText = patch.replaceText ?? "";
      console.log(
        `[smoke] multi-fix product_seo/descriptionHtml across ${targetIds.length} product(s): ` +
          `find=${JSON.stringify(findText).slice(0, 80)}`,
      );
      if (!findText) {
        console.log(`[smoke] SKIP multi-fix: missing findText`);
        skipped += 1;
        continue;
      }

      for (const targetId of targetIds) {
        const label = `product_seo/descriptionHtml on ${targetId} (multi)`;
        try {
          const targetPatch: Patch = {
            fixType: "product_seo",
            field: "descriptionHtml",
            targetId,
          };
          const target = await resolveTarget(shop, token, "product_seo", targetPatch);
          if ("error" in target) {
            console.log(`[smoke] SKIP ${label}: resolve error ${target.error}`);
            skipped += 1;
            if (target.error === "invalid_field") invalidFieldSkips += 1;
            continue;
          }

          const { currentLive } = target;
          const found = typeof currentLive === "string" && currentLive.includes(findText);
          if (!found) {
            console.log(`[smoke] SKIP ${label}: phrase already absent from this product`);
            skipped += 1;
            continue;
          }
          const computedValue = (currentLive as string)
            .split(findText)
            .join(replaceText)
            .replace(/[ \t]{2,}/g, " ")
            .trim();

          const key = `${targetId}|descriptionHtml`;
          const hasSnapshot = Object.prototype.hasOwnProperty.call(snapshots, key);
          const capturedValue = hasSnapshot ? snapshots[key] : "";
          const drift =
            hasSnapshot &&
            norm(currentLive, { stripTags: true }) !== norm(capturedValue, { stripTags: true });
          if (drift) {
            console.log(
              `[smoke] SKIP ${label}: drift detected (audit snapshot differs from live value)`,
            );
            skipped += 1;
            driftSkips += 1;
            continue;
          }

          const userErrors = await target.write(computedValue ?? "");
          if (userErrors.length) {
            console.log(
              `[smoke] SKIP ${label}: Shopify rejected the write - ${userErrors
                .map((e) => e.message)
                .join(" ")}`,
            );
            skipped += 1;
            continue;
          }

          await updateFieldSnapshot(result.auditId, key, computedValue ?? "").catch(() => {});
          snapshots = { ...snapshots, [key]: computedValue ?? "" };
          await recordFix({
            userId: USER_ID,
            shop,
            auditId: result.auditId,
            fixType: "product_seo",
            field: "descriptionHtml",
            targetId,
            previousValue: currentLive,
            newValue: computedValue,
          });
          console.log(`[smoke] APPLIED ${label}`);
          applied += 1;
        } catch (err) {
          console.log(`[smoke] ERROR ${label}: ${String(err)}`);
          errored += 1;
        }
      }
      continue;
    }

    const label = `${patch.fixType}/${patch.field ?? "-"} on ${
      issue.product ?? patch.targetId ?? "?"
    }`;
    try {
      const target = await resolveTarget(shop, token, patch.fixType ?? "", patch);
      if ("error" in target) {
        console.log(`[smoke] SKIP ${label}: resolve error ${target.error}`);
        skipped += 1;
        if (target.error === "invalid_field") invalidFieldSkips += 1;
        continue;
      }

      const { currentLive } = target;
      const snapshotField = snapshotFieldFor(patch.fixType ?? "", patch.field);
      const key = patch.targetId && snapshotField ? `${patch.targetId}|${snapshotField}` : null;
      const hasSnapshot = Boolean(key && Object.prototype.hasOwnProperty.call(snapshots, key));
      const capturedValue = hasSnapshot ? snapshots[key as string] : (patch.currentValue ?? "");
      const stripTags = patch.field === "descriptionHtml";
      const drift =
        hasSnapshot && norm(currentLive, { stripTags }) !== norm(capturedValue, { stripTags });
      if (drift) {
        console.log(
          `[smoke] SKIP ${label}: drift detected (audit snapshot differs from live value)`,
        );
        skipped += 1;
        driftSkips += 1;
        continue;
      }

      const userErrors = await target.write(patch.newValue ?? "");
      if (userErrors.length) {
        console.log(
          `[smoke] SKIP ${label}: Shopify rejected the write - ${userErrors
            .map((e) => e.message)
            .join(" ")}`,
        );
        skipped += 1;
        continue;
      }

      if (key) {
        await updateFieldSnapshot(result.auditId, key, patch.newValue ?? "").catch(() => {});
        snapshots = { ...snapshots, [key]: patch.newValue ?? "" };
      }
      await recordFix({
        userId: USER_ID,
        shop,
        auditId: result.auditId,
        fixType: patch.fixType ?? "",
        field: patch.field ?? null,
        targetId: patch.targetId ?? null,
        previousValue: currentLive,
        newValue: patch.newValue ?? "",
      });
      console.log(`[smoke] APPLIED ${label}`);
      applied += 1;
    } catch (err) {
      console.log(`[smoke] ERROR ${label}: ${String(err)}`);
      errored += 1;
    }
  }

  console.log(
    `[smoke] fixes: ${applied} applied, ${skipped} skipped, ${errored} errored ` +
      `(${driftSkips} for drift, ${invalidFieldSkips} for invalid_field)`,
  );

  if (driftSkips > 0 || invalidFieldSkips > 0) {
    console.error(
      `[smoke] FAIL: ${driftSkips} fix(es) skipped for drift, ${invalidFieldSkips} skipped for invalid_field.`,
    );
    process.exitCode = 1;
    return;
  }

  console.log("[smoke] DONE - no fix skipped for drift or invalid_field.");
}

main().catch((err) => {
  console.error("[smoke] FATAL:", err);
  process.exitCode = 1;
});
