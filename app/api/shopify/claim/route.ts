import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { claimOrphanShop } from "../../../../lib/db";
import {
  PENDING_SHOP_COOKIE,
  readPendingShop,
} from "../../../../lib/pendingShopClaim";

export const runtime = "nodejs";

// Attaches a shop installed from the Shopify App Store to the account the
// merchant just created. The dashboard sends them here when the pending-claim
// cookie is present; cookies can only be cleared from a route handler, so the
// write lives here rather than in the dashboard render.
export async function GET(req: NextRequest) {
  const dashboard = NextResponse.redirect(
    new URL("/dashboard", req.nextUrl.origin),
    { status: 303 },
  );
  // Always drop the cookie, including on every failure path below: a cookie
  // that survived would send the dashboard straight back here in a loop.
  dashboard.cookies.delete(PENDING_SHOP_COOKIE);

  const { userId } = await auth();
  const shop = readPendingShop(req.cookies.get(PENDING_SHOP_COOKIE)?.value);
  if (!userId || !shop) return dashboard;

  try {
    const result = await claimOrphanShop(shop, userId);
    if (result === "already-owned") {
      // Someone else installed this shop first. Never reassign it.
      console.warn(
        `[shopify/claim] ${shop} already belongs to another user, ignoring claim by ${userId}`,
      );
    } else if (result === "not-found") {
      console.warn(`[shopify/claim] no stored install for ${shop}`);
    }
  } catch (err) {
    console.error(`[shopify/claim] failed to claim ${shop}`, err);
  }

  return dashboard;
}
