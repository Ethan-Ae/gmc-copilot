# Shopify Alignment Workflow

## Authoritative Order

Use this order when reconciling conflicts:

1. True business facts from the user or official settings
2. Shopify settings and checkout behavior
3. Shopify policies
4. Product data and SEO fields
5. Theme text, FAQ, banners, cart, footer, and navigation
6. Feed app mapping
7. Merchant Center visible values

Do not make the theme say something that policies/settings do not support.

## Store Settings To Check

Check these Shopify areas when access is available:

- Store details: store name, legal/business name, customer email, sender email, phone, address
- Markets: active markets, countries, domains/subfolders, currency behavior
- Payments: checkout availability and currency
- Shipping and delivery: shipping zones, rates, delivery estimates, handling times if present
- Taxes and duties: whether taxes/duties are included, collected, or mentioned
- Policies: refund, privacy, terms, shipping, legal notice
- Domains: primary domain and storefront domain
- Notifications: only if customer-facing wording contradicts policies
- Apps: feed app, tracking app, review app, badge app, upsell app, scarcity app

## Policy Edits

Policies are the source of truth for public support text. Make them complete and explicit:

- Shipping: processing time, delivery time, order cutoff if available, shipping cost, target countries, tracking if true
- Returns/refunds: return window, damaged goods, return shipping cost, refund processing time
- Contact: email, phone, support hours if used elsewhere
- Duties/taxes/import fees: exact statement if selling across borders

Use the same wording everywhere practical. If the policy says `5 - 7 business days`, do not write `5 to 7 days` elsewhere unless the store intentionally accepts that variation.

## Theme Audit

Inspect all templates and public pages, especially:

- homepage
- product pages
- collection pages
- cart drawer/cart page
- FAQ
- contact
- about/story
- footer
- announcement bar
- policy pages
- search/results
- tracking page

Remove or rewrite:

- review stars and testimonials
- Trustpilot or rating blocks
- warranty/guarantee blocks unless policy-backed
- "secure checkout" badge clusters if decorative or unsupported
- unsupported free delivery text
- unsupported duties/taxes text
- false cart/checkout statements
- sticky add-to-cart or stock widgets if they create inconsistent availability/urgency claims
- duplicate headings or layout bugs that look unprofessional

Keep product pages factual:

- product title
- product images
- variant selector
- price/currency
- product description
- policy links or neutral policy references

## Product Data and SEO

Check all active products:

- title and SEO title
- description and SEO description
- variant names
- price and compare-at price
- availability and inventory policy
- images
- handle/URL
- vendor/brand
- product type/category

Avoid product SEO phrases that sound like instructions to Google or unsupported claims. Prefer neutral descriptions:

`[Product] from [Brand]. Check variants, product images, delivery method and return information before ordering.`

If the feed app uses SEO title/description, update those fields and force feed app metadata sync.

## Currency and Market Alignment

For each market:

- Shopify active market country must match GMC country
- Storefront currency must match feed currency
- GMC shipping service currency must match product currency
- policy wording must match target country

If Google reports limited visibility due to currency mismatch:

1. Check product feed currency in GMC product detail.
2. Check GMC shipping service currency and country.
3. Check Shopify market currency and storefront URL.
4. Either unify shipping currency with product currency or configure market-specific product currency correctly.

## Feed Apps

For Simprosys:

- Confirm it is connected to the correct Google account and Merchant Center ID.
- Confirm primary domain matches Shopify primary domain.
- Confirm store currency is correct.
- Confirm product title mapping: usually `SEO title` when SEO was cleaned.
- Confirm product description mapping: usually `SEO Description` when SEO was cleaned.
- Confirm all intended products and variants are submitted.
- Confirm warnings/ineligible count is zero if possible.
- After SEO title/description changes, use `Re-Sync Meta Fields` and select `SEO Description` and `SEO title`.
- Then use the general `Re-sync` to push the full feed.
- Wait until the app queue finishes and products return to submitted/done status.
- Recheck GMC product detail. Do not trust Shopify alone.

For other feed apps, find equivalent controls:

- import/sync from Shopify
- sync metafields/SEO fields
- submit feed to GMC
- product diagnostics/warnings

## Common Fixes That Worked

- Remove fake or unsupported reviews/badges.
- Replace vague "free delivery" with exact cost wording.
- Align shipping policy and GMC shipping service exactly.
- Add missing shipping processing/cutoff details only when true.
- Add refund processing time and damaged goods section.
- Replace old SEO descriptions in Shopify products.
- Force Simprosys SEO metafield sync and full re-sync.
- Wait for GMC product detail to show the corrected description before requesting review.
