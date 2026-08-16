import { redirect } from "next/navigation";
import { getEnv, isValidShop, verifyHmac } from "../lib/shopify";
import LandingPage from "../src/LandingPage";

export const runtime = "nodejs";

type SearchParams = Record<string, string | string[] | undefined>;

// Shopify opens the app root with ?shop=&hmac=&timestamp=... on install and on
// every launch from the admin. When the signature checks out we hand the shop
// straight to the existing OAuth entry point instead of rendering the landing.
// Anything unsigned or malformed is just a normal visitor: render the landing.
function inboundInstallShop(params: SearchParams): string | null {
  const shop = single(params.shop)?.trim().toLowerCase();
  if (!shop || !isValidShop(shop)) return null;
  if (!single(params.hmac)) return null;

  let apiSecret: string;
  try {
    ({ apiSecret } = getEnv());
  } catch {
    // Shopify env not configured: never break the public landing over it.
    return null;
  }

  // The signature covers every query param Shopify sent, not just the ones we
  // read here, so rebuild the full set before verifying.
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    query.set(key, Array.isArray(value) ? value.join(",") : value);
  }

  return verifyHmac(query, apiSecret) ? shop : null;
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const shop = inboundInstallShop(await searchParams);
  if (shop) {
    redirect(`/api/shopify/auth?shop=${encodeURIComponent(shop)}`);
  }
  return <LandingPage />;
}
