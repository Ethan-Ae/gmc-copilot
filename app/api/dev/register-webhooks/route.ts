import { NextRequest } from "next/server";
import { jsonResponse } from "../../../../lib/apiJson";
import { isValidShop } from "../../../../lib/shopify";
import {
  getShopifyAccessToken,
  ShopifyReauthRequired,
} from "../../../../lib/shopifyToken";
import { shopifyGraphQL, type UserError } from "../../../../lib/shopifyFix";

export const runtime = "nodejs";

// Dev/maintenance helper: the OAuth callback only wires webhooks for fresh
// installs, so a shop installed before app_subscriptions/update existed has no
// subscription. This route registers it idempotently on an already-installed
// (test) shop. Gated to test shops only.
const TOPIC = "APP_SUBSCRIPTIONS_UPDATE";
const CALLBACK_URL =
  "https://feedcompliant.com/api/webhooks/shopify/app-subscriptions-update";

function isTestShop(shop: string): boolean {
  return (process.env.BILLING_TEST_SHOPS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(shop);
}

type WebhookNode = {
  id: string;
  topic: string;
  endpoint: { __typename: string; callbackUrl?: string } | null;
};

// List the shop's HTTP webhook subscriptions as flat { topic, callbackUrl }.
async function listWebhooks(
  shop: string,
  token: string,
): Promise<{ topic: string; callbackUrl: string | null }[]> {
  const data = await shopifyGraphQL<{
    webhookSubscriptions: { edges: { node: WebhookNode }[] };
  }>(
    shop,
    token,
    `{
      webhookSubscriptions(first: 20) {
        edges {
          node {
            id
            topic
            endpoint {
              __typename
              ... on WebhookHttpEndpoint { callbackUrl }
            }
          }
        }
      }
    }`,
    {},
  );

  return (data.webhookSubscriptions?.edges ?? []).map((e) => ({
    topic: e.node.topic,
    callbackUrl: e.node.endpoint?.callbackUrl ?? null,
  }));
}

export async function POST(req: NextRequest) {
  let body: { shop?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonResponse({ error: "invalid_json" }, { status: 400 });
  }

  const shop = body.shop?.trim().toLowerCase();
  if (!shop || !isValidShop(shop)) {
    return jsonResponse({ error: "invalid_shop" }, { status: 400 });
  }

  // Protection: this route does not exist for non-test shops.
  if (!isTestShop(shop)) {
    return jsonResponse({ error: "not_found" }, { status: 404 });
  }

  let token: string;
  try {
    token = await getShopifyAccessToken(shop);
  } catch (err) {
    if (err instanceof ShopifyReauthRequired) {
      return jsonResponse({ error: "shopify_reauth_required" }, { status: 401 });
    }
    return jsonResponse({ error: "shopify_token_error" }, { status: 502 });
  }

  try {
    const existing = await listWebhooks(shop, token);

    // Idempotent: only create when this exact topic + callback is not present.
    const alreadyRegistered = existing.some(
      (w) => w.topic === TOPIC && w.callbackUrl === CALLBACK_URL,
    );

    let created = false;
    if (!alreadyRegistered) {
      const data = await shopifyGraphQL<{
        webhookSubscriptionCreate: {
          webhookSubscription: { id: string } | null;
          userErrors: UserError[];
        };
      }>(
        shop,
        token,
        `mutation RegisterWebhook($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
          webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
            webhookSubscription { id }
            userErrors { field message }
          }
        }`,
        {
          topic: TOPIC,
          sub: { callbackUrl: CALLBACK_URL, format: "JSON" },
        },
      );

      const payload = data.webhookSubscriptionCreate;
      if (payload.userErrors?.length) {
        return jsonResponse(
          { error: "register_failed", userErrors: payload.userErrors },
          { status: 502 },
        );
      }
      created = true;
    }

    // Re-read so the response reflects the real final state.
    const finalWebhooks = await listWebhooks(shop, token);
    return jsonResponse({
      shop,
      created,
      alreadyRegistered,
      webhooks: finalWebhooks,
    });
  } catch (err) {
    return jsonResponse(
      { error: "register_failed", detail: String(err) },
      { status: 502 },
    );
  }
}
