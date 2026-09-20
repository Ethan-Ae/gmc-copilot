import LandingPage from "../src/LandingPage";
import { getShopifyAppStoreUrl } from "../lib/shopify";

export const runtime = "nodejs";

// Shopify's signed shop+hmac launch (install/reinstall/reopen) is handled in
// middleware (proxy.ts -> lib/shopifyInstallGate.ts), which redirects to
// OAuth before this component ever renders when required. Reaching here
// means either a normal visitor, or a shop whose connection is already
// valid - both get the landing page.
export default function Home() {
  return <LandingPage appStoreUrl={getShopifyAppStoreUrl()} />;
}
