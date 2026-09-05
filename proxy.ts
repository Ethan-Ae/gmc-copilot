import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const isProtectedRoute = createRouteMatcher(["/dashboard(.*)"]);

export default clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) {
    await auth.protect();
  }
});

export const config = {
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
