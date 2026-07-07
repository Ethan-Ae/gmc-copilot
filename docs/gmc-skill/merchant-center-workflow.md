# Merchant Center Browser Workflow

## Access Reality

The skill cannot store credentials or pre-connect to Merchant Center. Use the user's currently authenticated browser session when provided. If not authenticated, ask the user to sign in and return.

Use the in-app browser when available. Verify values from visible Merchant Center pages, not assumptions.

## Pages To Verify

Check these Merchant Center areas:

- Overview: global status, approved/refused/limited/under review counts
- Account issues or diagnostics: exact policy issue and review action
- Business info: business name, address, customer service URL, email, phone, contact preference
- Website: domain verified and claimed
- Countries: active countries and product readiness
- Shipping services: status, visibility, name, cost, delivery time, country, product scope
- Return policies: status, country, return period, return fees, product scope
- Data sources: source name, type, product count, country, language, feed label, marketing methods
- Product list: product statuses, prices, currencies, availability, source, last update
- Product detail: title, description, URL, price, currency, availability, country, methods, last update, source
- Shipping calculator on product detail: destination country/location, shipping service, cost, price, availability
- Product attention required tab: product-specific issues vs account/config issue

## Business Info Checklist

Confirm:

- brand/store name matches site
- legal/business address matches policies or legal page
- contact URL works and is present on site
- email matches site
- phone matches site if shown
- website domain is verified and claimed
- target countries match the store's real market

Payment/checkout modules shown as disabled in GMC are not automatically a misrepresentation blocker if normal website checkout works, but do not ignore a checkout-related account issue.

## Shipping Checklist

For each target country:

- service visible on Google
- status complete/valid
- country correct
- products `All` or intended selection
- cost matches site/policy/checkout
- delivery time matches policy
- currency matches product feed

If product detail shipping calculator says a generic phrase like "for an address in the United States" but selected country and location are target-market correct, treat the selected country/location as the authoritative signal.

## Return Checklist

Confirm:

- return policy status valid
- country correct
- return window matches public policy
- return fee responsibility matches public policy
- exceptions do not contradict products

## Product Source Checklist

Confirm:

- correct feed app/source
- correct Merchant API/file source
- correct country
- correct language
- correct feed label
- intended product count
- marketing methods include Shopping ads/free listings if needed

For Merchant API feeds, the source page may not show a meaningful `last updated`. Product detail last update is often more useful.

## Product Detail Propagation Rule

This is critical. After Shopify/feed changes, open at least one representative product detail in GMC and verify the corrected field appears there.

Examples:

- If Shopify SEO description changed from `Review variants` to `Check variants`, do not approve review until GMC product detail also shows `Check variants`.
- If currency mismatch was fixed, product detail must show product price and shipping service in the same currency.
- If shipping cost changed, shipping calculator must show the corrected cost.

If GMC still shows old data:

1. Verify Shopify product/SEO field is correct.
2. Verify feed app product detail is correct.
3. Resync metadata/SEO fields in feed app.
4. Resync full feed.
5. Wait until feed app queue is complete.
6. Reopen GMC product detail and confirm `Dernière mise à jour` or equivalent changed.

## Account Issue Page

For misrepresentation:

- Confirm the issue is global/account-level, not a hidden product/config mismatch.
- Open product `Attention requise` tab. If it says configuration/policy issue, open all account issues.
- Do not assume the issue is solved just because site looks clean.
- Request review only after all current site/feed/GMC mismatches are fixed.

## Review Request Guidance

If the account issue page shows a button such as "Je ne suis pas d'accord avec le problème" or "Request review", and all checks pass, tell the user they can request review.

Do not click final submission unless the user explicitly asked you to submit it and the browser safety rules allow it. It is acceptable to navigate to the issue page and tell the user what to click.
