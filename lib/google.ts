export function getGoogleEnv() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "Missing Google env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI",
    );
  }
  return { clientId, clientSecret, redirectUri };
}

// openid + email to identify the account, content to read Merchant Center
export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/content",
].join(" ");

// Exchange a stored refresh token for a fresh access token
export async function refreshAccessToken(refreshToken: string): Promise<string> {
  const { clientId, clientSecret } = getGoogleEnv();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error("Failed to refresh Google access token: " + (await res.text()));
  }
  const json = (await res.json()) as { access_token: string };
  return json.access_token;
}

const MERCHANT_BASE = "https://merchantapi.googleapis.com";

export interface MerchantAccount {
  id: string;
  name: string;
}

// Lists the Merchant Center accounts the Google user behind this refresh token
// administers. Used at OAuth callback to resolve and persist the account id.
export async function listMerchantAccounts(
  refreshToken: string,
): Promise<MerchantAccount[]> {
  const accessToken = await refreshAccessToken(refreshToken);
  const accRes = await fetch(`${MERCHANT_BASE}/accounts/v1/accounts`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  if (!accRes.ok) {
    throw new Error(`Merchant accounts.list failed (${accRes.status})`);
  }
  const accBody = (await accRes.json()) as {
    accounts?: { name: string; accountName?: string }[];
  };
  return (accBody.accounts ?? []).map((a) => {
    const id = a.name.split("/").pop() as string;
    return { id, name: a.accountName ?? id };
  });
}

export interface MerchantStatus {
  accountId: string;
  accountIssues: unknown;
  products: unknown;
}

// Reads the real Merchant Center status for a specific account: account-level
// issues and a sample of products with their item-level issues. The accountId
// is the one resolved and stored for the current user at connection time.
export async function getMerchantStatus(
  refreshToken: string,
  accountId: string | null,
): Promise<MerchantStatus> {
  if (!accountId) {
    throw new Error("Aucun compte Merchant Center associé");
  }
  const accessToken = await refreshAccessToken(refreshToken);
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };

  const issuesRes = await fetch(
    `${MERCHANT_BASE}/accounts/v1/accounts/${accountId}/issues?language_code=fr-FR&page_size=50`,
    { headers },
  );
  const accountIssues = await issuesRes.json();

  // Sample of products with their item-level issues, via the Reports API.
  let products: unknown = null;
  try {
    const repRes = await fetch(
      `${MERCHANT_BASE}/reports/v1/accounts/${accountId}/reports:search`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          query:
            "SELECT offer_id, title, item_issues FROM product_view LIMIT 50",
        }),
      },
    );
    products = await repRes.json();
  } catch {
    products = null;
  }

  return { accountId, accountIssues, products };
}
