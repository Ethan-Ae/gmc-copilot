import { NextRequest, NextResponse } from "next/server";
import { isSafeReturnPath, isValidShop } from "../../../../../lib/shopify";
import { getShopifyAccessToken } from "../../../../../lib/shopifyToken";
import { syncBillingState } from "../../../../../lib/shopifyBilling";

export const runtime = "nodejs";
export const maxDuration = 30;

// Public route: Shopify redirects the merchant here after they accept or
// decline a charge, so no Clerk session is guaranteed. It performs no
// param-driven writes - it only reconciles billing_state from the live Shopify
// API (the source of truth) and hands the merchant back to the dashboard.
export async function GET(req: NextRequest) {
  const shop = req.nextUrl.searchParams.get("shop")?.trim().toLowerCase();

  if (shop && isValidShop(shop)) {
    try {
      const token = await getShopifyAccessToken(shop);
      await syncBillingState(shop, token);
    } catch {
      // Sync is best-effort here; the status route can reconcile later.
    }
  }

  const returnPath = req.nextUrl.searchParams.get("returnPath");
  const path = returnPath && isSafeReturnPath(returnPath) ? returnPath : "/dashboard";
  const destination = new URL(path, req.nextUrl.origin);
  destination.searchParams.set("billing", "done");
  return NextResponse.redirect(destination, { status: 303 });
}
