// One-off utility: reset given policy types on a dev store back to an empty
// body. Needed because scripts/smoke-fix.ts really applies fixes through the
// live Shopify Admin API - a prior smoke run against fc-empty.myshopify.com
// wrote placeholder-laden bodies into SHIPPING_POLICY/REFUND_POLICY/
// TERMS_OF_SERVICE, so the store is no longer in its original "absent policy"
// state. Not part of the app; not meant to be run against a real merchant.
//
// Usage: npx tsx scripts/reset-policies.ts <shop>.myshopify.com POLICY_TYPE [POLICY_TYPE...]

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Patch } from "../lib/shopifyFix";

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

async function main() {
  const shop = process.argv[2]?.trim().toLowerCase();
  const types = process.argv.slice(3);
  if (!shop || types.length === 0) {
    console.error(
      "Usage: npx tsx scripts/reset-policies.ts <shop>.myshopify.com POLICY_TYPE [POLICY_TYPE...]",
    );
    process.exitCode = 1;
    return;
  }

  const { getShopifyAccessToken } = await import("../lib/shopifyToken");
  const { resolveTarget } = await import("../lib/shopifyFix");

  const token = await getShopifyAccessToken(shop);

  for (const type of types) {
    const patch: Patch = { fixType: "partial", targetId: type, field: type };
    const target = await resolveTarget(shop, token, "partial", patch);
    if ("error" in target) {
      console.log(`SKIP ${type}: ${target.error}`);
      continue;
    }
    const userErrors = await target.write("");
    if (userErrors.length) {
      console.log(`FAIL ${type}: ${userErrors.map((e) => e.message).join(" ")}`);
      continue;
    }
    console.log(`RESET ${type} to empty body`);
  }
}

main();
