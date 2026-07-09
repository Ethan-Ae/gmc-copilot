import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { auth } from "@clerk/nextjs/server";
import { getGoogleEnv, GOOGLE_SCOPES } from "../../../../lib/google";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const { clientId, redirectUri } = getGoogleEnv();

  const { userId } = await auth();
  if (!userId) {
    return NextResponse.redirect(new URL("/sign-in", req.nextUrl.origin));
  }

  // Anti-CSRF random lives in the cookie; the full state carries the userId too.
  const randomHex = crypto.randomBytes(16).toString("hex");
  const state = `${randomHex}.${userId}`;

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SCOPES);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);

  const res = NextResponse.redirect(url.toString());
  res.cookies.set("google_oauth_state", randomHex, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return res;
}
