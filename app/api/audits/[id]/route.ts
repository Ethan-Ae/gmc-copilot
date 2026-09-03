import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { jsonResponse } from "../../../../lib/apiJson";
import { getAuditById } from "../../../../lib/audits";
import { getEntitlements } from "../../../../lib/entitlements";
import { auditErrorMessage, type AuditErrorCode } from "../../../../lib/auditErrors";

export const runtime = "nodejs";
export const maxDuration = 15;

// Polled by the report page every 2s while an audit is queued/running.
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) {
    return jsonResponse({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;
  const row = await getAuditById(id, userId);
  if (!row) {
    return jsonResponse({ error: "not_found" }, { status: 404 });
  }

  if (row.status === "queued" || (row.status as string) === "pending") {
    return jsonResponse({
      auditId: row.id,
      status: "queued",
      progressStep: row.progress_step,
    });
  }

  if (row.status === "running") {
    return jsonResponse({
      auditId: row.id,
      status: "running",
      progressStep: row.progress_step,
    });
  }

  if (row.status === "failed") {
    // Never relay row.error_message (raw technical detail, kept in the DB
    // for debugging only): the client only ever sees the fixed, safe French
    // message for the error's category.
    return jsonResponse({
      auditId: row.id,
      status: "failed",
      error: auditErrorMessage(row.error_code as AuditErrorCode | null),
    });
  }

  // status === 'done'
  const entitlements = row.shop
    ? await getEntitlements(userId, row.shop)
    : null;

  return jsonResponse({
    auditId: row.id,
    status: "done",
    shop: row.shop,
    model: row.model,
    truncated: row.truncated,
    gmcConnected: row.gmc_connected,
    audit: row.result,
    entitlements: entitlements
      ? {
          canFullAudit: entitlements.canFullAudit,
          canApplyFixes: entitlements.canApplyFixes,
          source: entitlements.source,
        }
      : undefined,
  });
}
