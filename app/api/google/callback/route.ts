import { NextRequest, NextResponse } from "next/server";
import { jsonResponse } from "../../../../lib/apiJson";
import { getGoogleEnv, listMerchantAccounts } from "../../../../lib/google";
import {
  saveGoogleToken,
  saveMerchantResolution,
} from "../../../../lib/googleStore";

export const runtime = "nodejs";

type IdTokenPayload = { email?: string; sub?: string };

function decodeJwtPayload(jwt: string): IdTokenPayload {
  const part = jwt.split(".")[1] ?? "";
  const json = Buffer.from(
    part.replace(/-/g, "+").replace(/_/g, "/"),
    "base64",
  ).toString("utf8");
  return JSON.parse(json) as IdTokenPayload;
}

export async function GET(req: NextRequest) {
  const { clientId, clientSecret, redirectUri } = getGoogleEnv();
  const params = req.nextUrl.searchParams;

  const err = params.get("error");
  const code = params.get("code");
  const state = params.get("state");
  const cookieState = req.cookies.get("google_oauth_state")?.value;

  if (err) {
    return jsonResponse(
      { error: "Google returned an error", detail: err },
      { status: 400 },
    );
  }
  if (!code) {
    return jsonResponse({ error: "Missing code" }, { status: 400 });
  }

  // state = `${randomHex}.${userId}`; randomHex is checked against the cookie
  // and the userId must be the one embedded at /api/google/auth start.
  const [randomHex, ...userIdParts] = (state ?? "").split(".");
  const userId = userIdParts.join(".") || null;
  if (!randomHex || !cookieState || randomHex !== cookieState) {
    return jsonResponse({ error: "Invalid state" }, { status: 403 });
  }
  if (!userId) {
    return jsonResponse(
      { error: "Missing user in state" },
      { status: 403 },
    );
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!tokenRes.ok) {
    const detail = await tokenRes.text();
    return jsonResponse(
      { error: "Token exchange failed", detail },
      { status: 502 },
    );
  }

  const tok = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    id_token?: string;
    scope?: string;
  };

  let email: string | null = null;
  let sub: string | null = null;
  if (tok.id_token) {
    try {
      const payload = decodeJwtPayload(tok.id_token);
      email = payload.email ?? null;
      sub = payload.sub ?? null;
    } catch {
      // ignore malformed id_token
    }
  }
  if (!sub) sub = email ?? "unknown";

  const expiresAt = tok.expires_in
    ? new Date(Date.now() + tok.expires_in * 1000).toISOString()
    : null;

  // refresh_token is only returned on first consent (forced here via prompt=consent)
  let dashboardQuery = "";
  if (tok.refresh_token) {
    await saveGoogleToken(
      sub,
      email,
      tok.refresh_token,
      tok.access_token ?? null,
      expiresAt,
      userId,
    );

    // Resolve which Merchant Center account this user actually administers, so
    // audits no longer fall back to a shared/hardcoded account. A failure here
    // must not break the connection, so we swallow errors and let the user retry.
    try {
      const accounts = await listMerchantAccounts(tok.refresh_token);
      if (accounts.length === 1) {
        await saveMerchantResolution(sub, accounts[0].id, accounts, false);
      } else if (accounts.length > 1) {
        // Store the full list and default to the first; the dashboard will ask
        // the user to confirm which account to use.
        await saveMerchantResolution(sub, accounts[0].id, accounts, true);
        dashboardQuery = "?google=choose_account";
      } else {
        await saveMerchantResolution(sub, null, [], false);
        dashboardQuery = "?google=no_merchant_account";
      }
    } catch {
      // Leave merchant fields untouched; the user can reconnect to retry.
    }
  }

  // Connection done: hand the merchant back to their dashboard.
  const res = NextResponse.redirect(
    new URL(`/dashboard${dashboardQuery}`, req.nextUrl.origin),
  );
  res.cookies.delete("google_oauth_state");
  return res;
}
