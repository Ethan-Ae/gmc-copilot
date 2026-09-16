// Manual smoke test for lib/shopifyInstallGate.ts (Shopify App Review 2.3.2:
// OAuth must run before any UI renders, on every install/reinstall). Exercises
// the decision table directly with injected deps, so it needs no DB
// connection and never calls the real Shopify API.
//
// Usage: npx tsx scripts/smoke-install-gate.ts

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import crypto from "node:crypto";
import { NextRequest } from "next/server";
import {
  resolveInboundShopifyRequest,
  type InstallGateDeps,
} from "../lib/shopifyInstallGate";

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

const SHOP = "smoke-test-shop.myshopify.com";
const APP_URL = "https://feedcompliant.com";

function sign(secret: string, params: Record<string, string>): string {
  const message = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("&");
  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

function buildRequest(
  secret: string,
  extra: Record<string, string> = {},
  opts: { badHmac?: boolean; staleTimestamp?: boolean } = {},
): NextRequest {
  const timestamp = opts.staleTimestamp
    ? String(Math.floor(Date.now() / 1000) - 2 * 24 * 60 * 60) // 2 days old
    : String(Math.floor(Date.now() / 1000));
  const base: Record<string, string> = { shop: SHOP, timestamp, ...extra };
  const hmac = opts.badHmac ? "0".repeat(64) : sign(secret, base);
  const url = new URL(APP_URL);
  for (const [k, v] of Object.entries(base)) url.searchParams.set(k, v);
  url.searchParams.set("hmac", hmac);
  return new NextRequest(url);
}

async function main(): Promise<void> {
  const secret = process.env.SHOPIFY_API_SECRET;
  const appUrlEnv = process.env.SHOPIFY_APP_URL;
  if (!secret || !appUrlEnv || !process.env.SHOPIFY_API_KEY) {
    console.error(
      "[smoke-install-gate] FATAL: SHOPIFY_API_KEY/SECRET/APP_URL not set (check .env.local)",
    );
    process.exitCode = 1;
    return;
  }

  type Case = {
    name: string;
    req: NextRequest;
    deps: InstallGateDeps;
    expect: "oauth-redirect" | "oauth-breakout" | "pass-through";
  };

  const noopDelete = async () => {};

  const cases: Case[] = [
    {
      name: "pas de token",
      req: buildRequest(secret),
      deps: {
        getShopToken: async () => null,
        deleteShopToken: noopDelete,
        isTokenValid: async () => {
          throw new Error("should not be called: no token to validate");
        },
      },
      expect: "oauth-redirect",
    },
    {
      name: "token valide",
      req: buildRequest(secret),
      deps: {
        getShopToken: async () => "tok_valid",
        deleteShopToken: async () => {
          throw new Error("should not be called: token is valid");
        },
        isTokenValid: async () => true,
      },
      expect: "pass-through",
    },
    {
      name: "token revoque",
      req: buildRequest(secret),
      deps: {
        getShopToken: async () => "tok_revoked",
        deleteShopToken: async (shop) => {
          if (shop !== SHOP) throw new Error("deleted wrong shop");
        },
        isTokenValid: async () => false, // simulates a 401/403 from Shopify
      },
      expect: "oauth-redirect",
    },
    {
      name: "hmac invalide",
      req: buildRequest(secret, {}, { badHmac: true }),
      deps: {
        getShopToken: async () => {
          throw new Error("should not be called: hmac never verified");
        },
        deleteShopToken: noopDelete,
        isTokenValid: async () => true,
      },
      expect: "pass-through",
    },
    {
      name: "embedded=1",
      req: buildRequest(secret, { embedded: "1" }),
      deps: {
        getShopToken: async () => null,
        deleteShopToken: noopDelete,
        isTokenValid: async () => {
          throw new Error("should not be called: no token to validate");
        },
      },
      expect: "oauth-breakout",
    },
  ];

  let failures = 0;
  const rows: string[] = [];

  for (const c of cases) {
    let outcome: string;
    let ok: boolean;
    try {
      const res = await resolveInboundShopifyRequest(c.req, c.deps);
      if (res === null) {
        outcome = "pass-through (render normally)";
        ok = c.expect === "pass-through";
      } else if (res.headers.get("content-type")?.includes("text/html")) {
        const body = await res.text();
        const isBreakout = body.includes("window.top.location.href");
        outcome = isBreakout
          ? "200 HTML iframe breakout -> /api/shopify/auth"
          : `unexpected HTML response (status ${res.status})`;
        ok = c.expect === "oauth-breakout" && isBreakout;
      } else {
        const location = res.headers.get("location") ?? "";
        outcome = `redirect(${res.status}) -> ${location}`;
        ok =
          c.expect === "oauth-redirect" &&
          res.status >= 300 &&
          res.status < 400 &&
          location.includes("/api/shopify/auth");
      }
    } catch (err) {
      outcome = `threw: ${String(err)}`;
      ok = false;
    }
    if (!ok) failures += 1;
    rows.push(
      `${ok ? "PASS" : "FAIL"} | ${c.name.padEnd(16)} | expected=${c.expect.padEnd(15)} | got: ${outcome}`,
    );
  }

  console.log("[smoke-install-gate] Decision table:");
  for (const row of rows) console.log(`  ${row}`);

  if (failures > 0) {
    console.error(`\n[smoke-install-gate] FAIL: ${failures}/${cases.length} case(s) failed`);
    process.exitCode = 1;
    return;
  }
  console.log(`\n[smoke-install-gate] DONE - all ${cases.length} cases passed.`);
}

main().catch((err) => {
  console.error("[smoke-install-gate] FATAL:", err);
  process.exitCode = 1;
});
