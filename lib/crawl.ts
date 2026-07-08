// Public storefront crawler used by the audit engine.
// It fetches the home page, the default Shopify policy pages, the contact/about
// pages, and a few product pages, then returns stripped plain text so the
// auditor can check policies, storefront claims, and cross-surface consistency.

export interface CrawledPage {
  url: string;
  status: number;
  text: string;
}

export interface CrawlResult {
  locked: boolean;
  pages: CrawledPage[];
}

const PAGE_TIMEOUT_MS = 6000;
const MAX_CHARS = 3000;
const MAX_PRODUCTS = 3;

// Default Shopify surfaces that matter for a GMC review. Contact/about may 404
// on stores that never created them; that is handled gracefully by the caller.
const STATIC_PATHS = [
  "/",
  "/policies/refund-policy",
  "/policies/shipping-policy",
  "/policies/privacy-policy",
  "/policies/terms-of-service",
  "/policies/legal-notice",
  "/policies/subscription-policy",
  "/pages/contact",
  "/pages/about",
];

interface RawPage {
  url: string;
  status: number;
  html: string;
}

// GET a single page with a hard per-request timeout. Never throws: on timeout,
// network error, or abort it resolves with status 0 and empty HTML.
async function fetchPage(url: string): Promise<RawPage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "GMC-Copilot-Audit/1.0 (+https://gmc-copilot.app)",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    const html = await res.text();
    // res.url reflects the final URL after redirects (used for lock detection).
    return { url: res.url || url, status: res.status, html };
  } catch {
    return { url, status: 0, html: "" };
  } finally {
    clearTimeout(timer);
  }
}

// A locked Shopify store redirects the storefront to /password and serves the
// "Opening soon" template. Detect it from the final URL and template markers.
function isPasswordPage(finalUrl: string, html: string): boolean {
  if (/\/password(?:[/?#]|$)/.test(finalUrl)) return true;
  const lower = html.toLowerCase();
  return (
    lower.includes("template-password") ||
    lower.includes("page-password") ||
    lower.includes("password-page") ||
    lower.includes('action="/password"') ||
    lower.includes("enter store using password") ||
    lower.includes("utiliser un mot de passe pour entrer") ||
    lower.includes("opening soon")
  );
}

function safeFromCodePoint(cp: number): string {
  try {
    return String.fromCodePoint(cp);
  } catch {
    return "";
  }
}

// Minimal HTML entity decoding (named essentials + numeric).
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#0*39;|&#x0*27;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) =>
      safeFromCodePoint(parseInt(h, 16)),
    )
    .replace(/&#(\d+);/g, (_, d: string) => safeFromCodePoint(parseInt(d, 10)));
}

// Turn an HTML document into collapsed plain text, truncated to limit tokens.
function stripHtml(html: string): string {
  const withoutBlocks = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const text = decodeEntities(withoutBlocks.replace(/<[^>]+>/g, " "));
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_CHARS);
}

/**
 * Crawl the public storefront for a shop.
 *
 * @param shop           full myshopify domain, e.g. "example.myshopify.com"
 * @param productHandles product handles from the Admin API (first 3 are used)
 */
export async function crawlStorefront(
  shop: string,
  productHandles: string[],
): Promise<CrawlResult> {
  const base = `https://${shop}`;

  const handles = productHandles
    .filter((h): h is string => typeof h === "string" && h.length > 0)
    .slice(0, MAX_PRODUCTS);

  const paths = [
    ...STATIC_PATHS,
    ...handles.map((h) => `/products/${encodeURIComponent(h)}`),
  ];

  const raw = await Promise.all(paths.map((p) => fetchPage(`${base}${p}`)));

  // The home page is the reference for whether the whole store is locked.
  const locked = raw.length > 0 && isPasswordPage(raw[0].url, raw[0].html);

  const pages: CrawledPage[] = raw.map((r) => ({
    url: r.url,
    status: r.status,
    // When locked every page is the same password wall, and non-200 responses
    // (404s, network errors) carry no useful body - keep those empty.
    text: !locked && r.status === 200 ? stripHtml(r.html) : "",
  }));

  return { locked, pages };
}
