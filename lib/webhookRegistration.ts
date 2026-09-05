// App-specific (per-shop) webhook subscriptions registered via the Admin API
// rather than shopify.app.toml. Needed for topics that TOML-level
// [[webhooks.subscriptions]] cannot express with use_legacy_install_flow
// enabled ("App-specific webhook subscriptions are not supported when
// use_legacy_install_flow is enabled" on `shopify app deploy`).
import { shopifyGraphQL, type UserError } from "./shopifyFix";

type WebhookNode = {
  topic: string;
  endpoint: { __typename: string; callbackUrl?: string } | null;
};

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

// Idempotent: lists existing subscriptions first and only creates one when
// this exact topic + callback URL is not already present. Throws on a real
// GraphQL/userErrors failure - callers that must not fail the surrounding
// flow (e.g. the OAuth callback) should wrap this in their own try/catch.
export async function ensureWebhookSubscription(
  shop: string,
  token: string,
  topic: string,
  callbackUrl: string,
): Promise<{ created: boolean }> {
  const existing = await listWebhooks(shop, token);
  const alreadyRegistered = existing.some(
    (w) => w.topic === topic && w.callbackUrl === callbackUrl,
  );
  if (alreadyRegistered) return { created: false };

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
      topic,
      sub: { callbackUrl, format: "JSON" },
    },
  );

  const payload = data.webhookSubscriptionCreate;
  if (payload.userErrors?.length) {
    throw new Error(
      `webhookSubscriptionCreate userErrors: ${payload.userErrors
        .map((e) => e.message)
        .join(" ")}`,
    );
  }
  return { created: true };
}
