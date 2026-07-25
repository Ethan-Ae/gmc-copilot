import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { jsonResponse } from "../../../../lib/apiJson";
import { selectMerchantAccount } from "../../../../lib/googleStore";

export const runtime = "nodejs";

// Lets a signed-in user pick which Merchant Center account to use when their
// Google login administers several. Ownership is enforced in the store: the id
// must belong to the list resolved for THIS user at connection time.
export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return jsonResponse({ error: "Unauthorized" }, { status: 401 });
  }

  let accountId: string | undefined;
  try {
    const body = (await req.json()) as { accountId?: unknown };
    accountId = typeof body.accountId === "string" ? body.accountId.trim() : undefined;
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!accountId || !/^\d+$/.test(accountId)) {
    return jsonResponse(
      { error: "Missing or invalid accountId" },
      { status: 400 },
    );
  }

  const ok = await selectMerchantAccount(userId, accountId);
  if (!ok) {
    return jsonResponse(
      { error: "Ce compte ne fait pas partie de vos comptes Merchant Center." },
      { status: 403 },
    );
  }

  return jsonResponse({ ok: true, merchant_account_id: accountId });
}
