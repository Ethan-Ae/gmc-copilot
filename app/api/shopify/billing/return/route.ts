import { NextRequest, NextResponse } from "next/server";
import { isValidShop } from "../../../../../lib/shopify";
import { getShopToken } from "../../../../../lib/db";
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
    const token = await getShopToken(shop);
    if (token) {
      try {
        await syncBillingState(shop, token);
      } catch {
        // Sync is best-effort here; the status route can reconcile later.
      }
    }
  }

  const dashboardUrl = new URL("/dashboard", req.nextUrl.origin);
  dashboardUrl.searchParams.set("billing", "done");
  return NextResponse.redirect(dashboardUrl, { status: 303 });
}
