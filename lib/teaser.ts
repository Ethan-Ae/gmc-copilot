import { neon } from "@neondatabase/serverless";

function db() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Missing DATABASE_URL env var");
  return neon(url);
}

let ready = false;
async function ensureSchema(): Promise<void> {
  if (ready) return;
  const sql = db();
  await sql`
    create table if not exists teaser_audits (
      domain text primary key,
      result jsonb not null,
      created_at timestamptz not null default now()
    )
  `;
  await sql`
    create table if not exists teaser_hits (
      ip text,
      created_at timestamptz not null default now()
    )
  `;
  ready = true;
}

// Reduce any user-provided URL to a bare host: no scheme, no www, no path,
// lowercase. Returns null when nothing parseable is left.
export function normalizeDomain(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let s = input.trim().toLowerCase();
  if (!s) return null;
  if (!/^https?:\/\//.test(s)) s = `https://${s}`;
  let host: string;
  try {
    host = new URL(s).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^www\./, "");
  if (!host || !host.includes(".")) return null;
  return host;
}

// Best-effort client IP from the proxy header. First entry of x-forwarded-for
// is the original client; fall back to a constant so counting still works.
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for") ?? "";
  const first = xff.split(",")[0]?.trim();
  return first || "unknown";
}

// A cached teaser result younger than 7 days, or null.
export async function getFreshTeaser(domain: string): Promise<unknown | null> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql`
    select result
    from teaser_audits
    where domain = ${domain}
      and created_at >= now() - interval '7 days'
  `) as { result: unknown }[];
  return rows.length ? rows[0].result : null;
}

export async function saveTeaser(
  domain: string,
  result: unknown,
): Promise<void> {
  await ensureSchema();
  const sql = db();
  await sql`
    insert into teaser_audits (domain, result, created_at)
    values (${domain}, ${JSON.stringify(result)}, now())
    on conflict (domain) do update set
      result = excluded.result,
      created_at = now()
  `;
}

export async function recordTeaserHit(ip: string): Promise<void> {
  await ensureSchema();
  const sql = db();
  await sql`insert into teaser_hits (ip) values (${ip})`;
}

export async function countHitsForIpLast24h(ip: string): Promise<number> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql`
    select count(*)::int as n
    from teaser_hits
    where ip = ${ip} and created_at >= now() - interval '24 hours'
  `) as { n: number }[];
  return rows.length ? rows[0].n : 0;
}

export async function countAllHitsLast24h(): Promise<number> {
  await ensureSchema();
  const sql = db();
  const rows = (await sql`
    select count(*)::int as n
    from teaser_hits
    where created_at >= now() - interval '24 hours'
  `) as { n: number }[];
  return rows.length ? rows[0].n : 0;
}
