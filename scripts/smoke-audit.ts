// Manual smoke test for the audit + fix pipeline. Runs the same audit engine
// and fix-write logic used by POST /api/audits/[id]/run and POST /api/fix,
// but calls them directly (no Clerk session, no HTTP layer, no quota) so it
// can run standalone against a real dev store already connected in the DB.
// It must complete without an uncaught exception on any store, including an
// empty one (no products, no policies).
//
// Usage: npx tsx scripts/smoke-audit.ts <shop>.myshopify.com

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

async function main(): Promise<void> {
  const shop = process.argv[2]?.trim().toLowerCase();
  if (!shop) {
    console.error("Usage: npx tsx scripts/smoke-audit.ts <shop>.myshopify.com");
    process.exitCode = 1;
    return;
  }

  const { getShopifyAccessToken, ShopifyReauthRequired } = await import(
    "../lib/shopifyToken"
  );
  const { runAuditForShop } = await import("../lib/auditEngine");
  const { resolveTarget, norm } = await import("../lib/shopifyFix");

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
    userId: "smoke-test",
    shop,
    token,
    source: "manual",
    onProgress: async (step) => {
      console.log(`[smoke] progress: ${step}`);
    },
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `[smoke] audit done in ${seconds}s - overall=${result.overall} ` +
      `products=${result.productsAudited}${
        result.productsTotal != null ? `/${result.productsTotal}` : ""
      } truncated=${result.truncated} gmcConnected=${result.gmcConnected} ` +
      `needsReauth=${result.needsReauth}`,
  );

  if (result.warnings.length) {
    console.log(`[smoke] ${result.warnings.length} warning(s) during the audit:`);
    for (const w of result.warnings) console.log(`  - ${w}`);
  }

  const issues = (result.audit.issues as SmokeIssue[] | undefined) ?? [];
  console.log(`[smoke] ${issues.length} issue(s) reported`);

  const autoIssues = issues.filter(
    (i): i is SmokeIssue & { patch: Patch } => Boolean(i.patch?.autoApplicable),
  );
  console.log(`[smoke] ${autoIssues.length} auto-applicable fix(es) to try`);

  let applied = 0;
  let skipped = 0;
  let errored = 0;
  for (const issue of autoIssues) {
    const patch = issue.patch;
    const label = `${patch.fixType}/${patch.field ?? "-"} on ${
      issue.product ?? patch.targetId ?? "?"
    }`;
    try {
      const target = await resolveTarget(shop, token, patch.fixType ?? "", patch);
      if ("error" in target) {
        console.log(`[smoke] SKIP ${label}: resolve error ${target.error}`);
        skipped += 1;
        continue;
      }
      const drift = norm(target.currentLive) !== norm(patch.currentValue ?? "");
      if (drift) {
        console.log(`[smoke] SKIP ${label}: audit snapshot differs from live value`);
        skipped += 1;
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
      console.log(`[smoke] APPLIED ${label}`);
      applied += 1;
    } catch (err) {
      console.log(`[smoke] ERROR ${label}: ${String(err)}`);
      errored += 1;
    }
  }

  console.log(
    `[smoke] fixes: ${applied} applied, ${skipped} skipped, ${errored} errored`,
  );
  console.log("[smoke] DONE - no uncaught exception.");
}

main().catch((err) => {
  console.error("[smoke] FATAL:", err);
  process.exitCode = 1;
});
