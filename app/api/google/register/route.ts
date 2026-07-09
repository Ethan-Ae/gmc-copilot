import { NextRequest } from "next/server";
import { jsonResponse } from "../../../../lib/apiJson";
import { refreshAccessToken } from "../../../../lib/google";
import { getLatestGoogleToken } from "../../../../lib/googleStore";

export const runtime = "nodejs";

// One-time developer registration: links this GCP project to a Merchant Center
// account the connected Google user administers. Unlocks all Merchant API calls
// from this project. Usage: /api/google/register?accountId=<numeric MC id>
export async function GET(req: NextRequest) {
  const accountId = req.nextUrl.searchParams.get("accountId")?.trim();
  if (!accountId || !/^\d+$/.test(accountId)) {
    return jsonResponse(
      {
        error:
          "Missing or invalid accountId. Pass the numeric Merchant Center account ID: /api/google/register?accountId=123456789",
      },
      { status: 400 },
    );
  }

  const stored = await getLatestGoogleToken();
  if (!stored) {
    return jsonResponse(
      { error: "No Google account connected. Visit /api/google/auth first." },
      { status: 404 },
    );
  }

  let accessToken: string;
  try {
    accessToken = await refreshAccessToken(stored.refresh_token);
  } catch (e) {
    return jsonResponse(
      { error: "Token refresh failed", detail: String(e) },
      { status: 502 },
    );
  }

  const url = `https://merchantapi.googleapis.com/accounts/v1/accounts/${accountId}/developerRegistration:registerGcp`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ developerEmail: stored.email }),
  });

  const body = await res.json();
  if (!res.ok) {
    return jsonResponse(
      { registered: false, status: res.status, error: body },
      { status: 502 },
    );
  }

  return jsonResponse({
    registered: true,
    developerEmail: stored.email,
    result: body,
    note: "GCP project registered. Wait ~5 minutes, then open /api/google/merchant.",
  });
}
