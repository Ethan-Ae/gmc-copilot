import { NextRequest } from "next/server";
import { jsonResponse } from "../../../../../lib/apiJson";
import {
  getShopifyAccessToken,
  ShopifyReauthRequired,
} from "../../../../../lib/shopifyToken";
import {
  getAuditByIdInternal,
  markAuditFailed,
  markAuditRunning,
} from "../../../../../lib/audits";
import { runAuditForShop } from "../../../../../lib/auditEngine";

export const runtime = "nodejs";
export const maxDuration = 300;

// Does the actual audit work: Shopify reads + the Claude call. Triggered from
// POST /api/audits right after it reserves the row, authenticated with a
// shared secret instead of a Clerk session since it is a server-to-server
// call, not a browser request.
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const secret = process.env.AUDIT_WORKER_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!secret || authHeader !== `Bearer ${secret}`) {
    return jsonResponse({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;
  const row = await getAuditByIdInternal(id);
  if (!row) {
    return jsonResponse({ error: "not_found" }, { status: 404 });
  }

  // Idempotency: after() can in rare cases fire more than once (e.g. a
  // platform retry). Only a 'queued' (or legacy 'pending') row should start
  // work; anything else already started or finished.
  if (row.status !== "queued" && (row.status as string) !== "pending") {
    return jsonResponse({ status: row.status, skipped: true });
  }

  if (!row.shop || !row.user_id) {
    await markAuditFailed(id, "Donnees d'audit incompletes.").catch(() => {});
    return jsonResponse({ error: "invalid_audit_row" }, { status: 500 });
  }

  await markAuditRunning(id, "Lecture des produits").catch(() => {});

  let token: string;
  try {
    token = await getShopifyAccessToken(row.shop);
  } catch (err) {
    const message =
      err instanceof ShopifyReauthRequired
        ? "La connexion Shopify a expire. Reconnectez la boutique."
        : "Impossible d'obtenir un jeton d'acces Shopify.";
    await markAuditFailed(id, message).catch(() => {});
    return jsonResponse({ status: "failed", error: message }, { status: 200 });
  }

  try {
    const result = await runAuditForShop({
      userId: row.user_id,
      shop: row.shop,
      token,
      source: "manual",
      auditId: id,
    });
    return jsonResponse({ status: "done", overall: result.overall });
  } catch (err) {
    // runAuditForShop already marks the row 'failed' with a readable message
    // on any internal error; this response is informational only, nothing
    // polls it directly (the client polls GET /api/audits/[id] instead).
    return jsonResponse({ status: "failed", detail: String(err) });
  }
}
