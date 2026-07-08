import { NextResponse } from "next/server";
import { refreshAccessToken } from "../../../../lib/google";
import { getLatestGoogleToken } from "../../../../lib/googleStore";

export const runtime = "nodejs";
export const maxDuration = 30;

const BASE = "https://merchantapi.googleapis.com/accounts/v1";

export async function GET() {
  const stored = await getLatestGoogleToken();
  if (!stored) {
    return NextResponse.json(
      { error: "No Google account connected. Visit /api/google/auth first." },
      { status: 404 },
    );
  }

  let accessToken: string;
  try {
    accessToken = await refreshAccessToken(stored.refresh_token);
  } catch (e) {
    return NextResponse.json(
      { error: "Token refresh failed", detail: String(e) },
      { status: 502 },
    );
  }

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
  };

  // 1. List Merchant Center accounts accessible to this Google user
  const accRes = await fetch(`${BASE}/accounts`, { headers });
  const accBody = await accRes.json();
  if (!accRes.ok) {
    return NextResponse.json(
      { step: "accounts.list", status: accRes.status, error: accBody },
      { status: 502 },
    );
  }

  const accounts = (accBody.accounts ?? []) as {
    name: string;
    accountName?: string;
  }[];

  // 2. For each account, read account-level issues (misrepresentation, etc.)
  const results = [];
  for (const acc of accounts.slice(0, 5)) {
    const id = acc.name.split("/").pop();
    const issuesRes = await fetch(
      `${BASE}/accounts/${id}/issues?language_code=fr-FR&page_size=50`,
      { headers },
    );
    const issuesBody = await issuesRes.json();
    results.push({
      account: acc.name,
      accountName: acc.accountName ?? null,
      issuesStatus: issuesRes.status,
      issues: issuesBody,
    });
  }

  return NextResponse.json({
    connected_google: stored.email,
    accounts_found: accounts.length,
    results,
    note:
      accounts.length === 0
        ? "No Merchant Center account is accessible from this Google account. Connect one that has a Merchant Center account (e.g. your friend's)."
        : "Merchant Center accounts read successfully.",
  });
}
