---
name: gmc-shopify-compliance-audit
description: Audit, repair, and verify Shopify stores for Google Merchant Center misrepresentation, limited visibility, product data, shipping, returns, currency, and policy consistency issues. Use when a user asks to make a Shopify site GMC compliant, remove or prevent misrepresentation, align policies/theme/Shopify settings/feed apps/Merchant Center, prepare for a GMC review request, or reproduce the strict Vyndra/Reformer Living compliance process.
---

# GMC Shopify Compliance Audit

## Core Rule

Make the store boringly verifiable. Every public claim must be true, supported elsewhere, and consistent across:

- Shopify settings
- Shopify policies
- theme content and navigation
- product titles, descriptions, variants, SEO fields, structured data, cart, checkout-adjacent text, and FAQs
- feed app data, such as Simprosys
- Google Merchant Center account, product source, countries, shipping, returns, product detail pages, and account issue pages

Do not optimize for persuasion. Optimize for auditability, consistency, and proof.

## Operating Standard

Work as if the strictest GMC auditor is trying to find one mismatch. Treat tiny inconsistencies as real risks:

- `9h00` vs `9h`
- `5-7 days` vs `5 - 7 days`
- `free delivery` vs `shipping cost is £0.00`
- a cart banner saying delivery details appear in cart when they do not
- product feed description differing from the live product page
- a review, badge, warranty, promotion, trust seal, or claim that cannot be proven

When writing public text, never invent facts. If a fact is not visible in policies or settings, either remove the claim or first make the underlying policy/setting true and visible.

For this user's stores, avoid em dashes in text you add. Use `-` instead.

## Reference Loading

Read only the references needed for the current task:

- Read `references/gmc-principles.md` for policy interpretation, misrepresentation risk, and prohibited claim patterns.
- Read `references/shopify-alignment.md` before editing Shopify settings, policies, theme files, navigation, product data, or feed-source inputs.
- Read `references/merchant-center-workflow.md` when the user has connected Merchant Center in the browser or asks for final GMC verification.
- Read `references/final-checklist.md` before telling the user to request review or before closing the task.

## Workflow

1. Identify the store, market, currency, business identity, target countries, feed source, and current GMC issue.
2. Crawl the public site and collect all visible claims: contact, address, business name, market/country, currency, prices, product availability, shipping, duties/taxes, returns/refunds, support hours, warranty, guarantees, reviews, badges, discounts, legal pages, FAQ, cart text, footer links, and product SEO.
3. Inspect Shopify policies and settings. Make policies complete before echoing them in the theme.
4. Align theme text to policies and settings. Remove unsupported trust claims, fake reviews, unsupported warranties, aggressive scarcity, unverified promotions, and any text that implies something not actually shown.
5. Align product data. Check product titles, product descriptions, SEO titles/descriptions, variants, prices, compare-at prices, availability, product URLs, image consistency, and feed app mapping.
6. Align Shopify settings with the site: business info, contact info, store currency, markets, shipping/delivery, returns, taxes/duties, domains, customer notifications where relevant, and app-based feed settings.
7. Verify the feed app. If Simprosys is used, verify source connection, SEO title/description mapping, submitted products, warnings, and resync meta fields after SEO changes.
8. Verify Merchant Center in the browser: business info, website verification/claim, countries, product source, shipping, returns, product list, sample product details, shipping calculator, product issue tab, and account issues.
9. Do not give a go-ahead for review until the data visible inside GMC has propagated. If Shopify or Simprosys is corrected but GMC still shows old text, wait or force sync, then recheck.
10. Give the user a short go/no-go answer with the residual risk and exact items verified.

## Modification Rules

- Prefer direct fixes when the user has granted access.
- Before editing files, state what you will change.
- Use Shopify APIs, CLI, theme editor, or browser UI according to available access.
- Do not change live business facts unless the user provided the correct replacement or the value is already present in an authoritative setting.
- Do not add reviews, star ratings, Trustpilot references, badges, certifications, guarantees, warranty claims, discounts, urgency, stock pressure, or delivery promises unless they are verified and required.
- Remove or neutralize unsupported claims instead of decorating around them.
- When in doubt, choose precise neutral language:
  - Good: `Delivery information is available in the shipping policy.`
  - Better when exact: `Orders are delivered in 5 - 7 business days.`
  - Bad unless literally true at that surface: `Fees and delivery times are shown in the cart.`

## Go/No-Go

Only say the user can request GMC review when:

- public site crawl has no broken internal compliance links and no unsupported risk claims
- policies, theme, Shopify settings, feed app, and GMC agree on business identity, contact, market, currency, shipping, returns, and product data
- Merchant Center product detail pages show current feed values
- account issues show only the reviewable global policy issue, not unresolved product/config mismatches

If any feed data or GMC page still shows old values, say no and explain exactly what must propagate or be resynced.
