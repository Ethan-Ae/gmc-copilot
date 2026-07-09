import { NextRequest, NextResponse } from "next/server";
import { getGoogleEnv } from "../../../../lib/google";
import { saveGoogleToken } from "../../../../lib/googleStore";

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
    return NextResponse.json(
      { error: "Google returned an error", detail: err },
      { status: 400 },
    );
  }
  if (!code) {
    return NextResponse.json({ error: "Missing code" }, { status: 400 });
  }

  // state = `${randomHex}.${userId}`; only randomHex is checked against the cookie.
  const [randomHex, ...userIdParts] = (state ?? "").split(".");
  const userId = userIdParts.join(".") || null;
  if (!randomHex || !cookieState || randomHex !== cookieState) {
    return NextResponse.json({ error: "Invalid state" }, { status: 403 });
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
    return NextResponse.json(
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
  if (tok.refresh_token) {
    await saveGoogleToken(
      sub,
      email,
      tok.refresh_token,
      tok.access_token ?? null,
      expiresAt,
      userId,
    );
  }

  const res = NextResponse.json({
    google_connected: true,
    email,
    sub,
    got_refresh_token: Boolean(tok.refresh_token),
    scope: tok.scope,
    note: "Google OAuth works. Next step: read Merchant Center via the Merchant API.",
  });
  res.cookies.delete("google_oauth_state");
  return res;
}
