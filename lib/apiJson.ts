import { NextResponse } from "next/server";

// All API JSON responses go through here so they always advertise an explicit
// UTF-8 charset (NextResponse.json only sets "application/json").
export function jsonResponse(body: unknown, init?: ResponseInit): NextResponse {
  const res = NextResponse.json(body, init);
  res.headers.set("content-type", "application/json; charset=utf-8");
  return res;
}
