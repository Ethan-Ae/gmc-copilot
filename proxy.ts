import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { resolveInboundShopifyRequest } from "./lib/shopifyInstallGate";

const isProtectedRoute = createRouteMatcher(["/dashboard(.*)"]);

export default clerkMiddleware(async (auth, req) => {
  // Shopify App Review 2.3.2: OAuth must run before any UI renders, on every
  // signed Shopify launch (install, reinstall, or reopening from the admin),
  // for the root URL and any other app URL. This never requires a Clerk
  // session - it must run before the protected-route check below, and before
  // Next ever renders a Server Component.
  const shopifyGate = await resolveInboundShopifyRequest(req);
  if (shopifyGate) return shopifyGate;

  if (isProtectedRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  // Proxy (formerly "middleware") always runs on the Node.js runtime in
  // Next.js 16, which is what lets the install gate above use Node's crypto
  // (HMAC verification) and a real DB round trip.
  matcher: [
    // Skip Next.js internals, all static files, and Shopify webhooks (unless
    // found in search params). Webhooks authenticate themselves with their
    // own raw-body HMAC check (see app/api/webhooks/shopify/route.ts) and
    // must never depend on Clerk being configured/reachable to respond -
    // Shopify grades these endpoints on reliability during App Store review.
    "/((?!_next|api/webhooks|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes, except Shopify webhooks.
    "/(api(?!/webhooks)|trpc)(.*)",
  ],
};
