import { NextRequest } from "next/server";
import { jsonResponse } from "../../../../lib/apiJson";
import {
  getShopifyAccessToken,
  ShopifyReauthRequired,
} from "../../../../lib/shopifyToken";
import { runAuditForShop } from "../../../../lib/auditEngine";
import { getLatestDoneAuditForShop } from "../../../../lib/audits";
import { computeAuditDiff, type AuditReport } from "../../../../lib/auditDiff";
import {
  selectShopsDueForReaudit,
  touchLastAutoAudit,
  insertAuditDiff,
} from "../../../../lib/autoReaudit";

export const runtime = "nodejs";
export const maxDuration = 300;

// Max shops re-audited per invocation. The daily cron catches up the rest.
const BATCH_SIZE = 3;

type ShopResult = {
  shop: string;
  status: "succeeded" | "failed";
  overall?: string;
  reason?: string;
  newIssues?: number;
  resolvedIssues?: number;
};

// Weekly automatic re-audit for subscribed shops. Runs the existing audit
// engine with source 'auto' (quota-free), then persists a diff against the
// previous audit so the future email module can alert merchants on new issues.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return jsonResponse({ error: "Unauthorized" }, { status: 401 });
  }

  const candidates = await selectShopsDueForReaudit(BATCH_SIZE);
  const shops: ShopResult[] = [];
  let succeeded = 0;
  let failed = 0;

  for (const candidate of candidates) {
    const { shop, user_id: userId } = candidate;

    // Stamp before running: a shop that fails is not retried every day, it
    // waits for the next 7-day window. Same principle as reserving the quota
    // row before the paid Claude call in the manual flow.
    try {
      await touchLastAutoAudit(shop);
    } catch (err) {
      failed += 1;
      shops.push({ shop, status: "failed", reason: `stamp_failed: ${String(err)}` });
      continue;
    }

    try {
      let token: string;
      try {
        token = await getShopifyAccessToken(shop);
      } catch (err) {
        if (err instanceof ShopifyReauthRequired) {
          // Session 2 will email "reconnect your shop". Here we just record it.
          failed += 1;
          shops.push({ shop, status: "failed", reason: "reauth_required" });
          continue;
        }
        throw err;
      }

      const result = await runAuditForShop({
        userId,
        shop,
        token,
        source: "auto",
      });

      // Diff against the most recent previous audit (any source), excluding the
      // one we just wrote. First-ever audit has no previous: everything is new.
      const previous = await getLatestDoneAuditForShop(shop, result.auditId);
      const diff = computeAuditDiff(
        (previous?.result ?? null) as AuditReport,
        result.audit as AuditReport,
      );

      await insertAuditDiff({
        shop,
        auditId: result.auditId,
        previousAuditId: previous?.id ?? null,
        newIssues: diff.newIssues,
        resolvedIssues: diff.resolvedIssues,
        unchangedCount: diff.unchangedCount,
      });

      succeeded += 1;
      shops.push({
        shop,
        status: "succeeded",
        overall: result.overall,
        newIssues: diff.newIssues.length,
        resolvedIssues: diff.resolvedIssues.length,
      });
    } catch (err) {
      // One shop failing must not block the others.
      failed += 1;
      shops.push({ shop, status: "failed", reason: String(err) });
    }
  }

  return jsonResponse({
    processed: candidates.length,
    succeeded,
    failed,
    shops,
  });
}
