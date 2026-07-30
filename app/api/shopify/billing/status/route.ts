import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { jsonResponse } from "../../../../../lib/apiJson";
import { isValidShop } from "../../../../../lib/shopify";
import { getShopOwner } from "../../../../../lib/db";
import { getBillingState } from "../../../../../lib/billingState";
import {
  oneTimeAccessActive,
  oneTimeAccessExpired,
} from "../../../../../lib/entitlements";

export const runtime = "nodejs";

// Returns the stored billing_state for a shop plus derived access flags for the
// dashboard UI: `full` when the one-time 30-day window is still open, `expired`
// when the charge is active but the window has elapsed.
export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return jsonResponse({ error: "unauthorized" }, { status: 401 });
  }

  const shop = req.nextUrl.searchParams.get("shop")?.trim().toLowerCase();
  if (!shop || !isValidShop(shop)) {
    return jsonResponse({ error: "invalid_shop" }, { status: 400 });
  }

  const owner = await getShopOwner(shop);
  if (owner !== userId) {
    return jsonResponse({ error: "forbidden" }, { status: 403 });
  }

  const state = await getBillingState(shop);
  return jsonResponse({
    shop,
    billing: state,
    access: {
      full: oneTimeAccessActive(state),
      expired: oneTimeAccessExpired(state),
    },
  });
}
