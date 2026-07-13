import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { jsonResponse } from "../../../lib/apiJson";
import { GMC_SKILL } from "../../../lib/gmcSkill";
import { crawlStorefront, type CrawlResult } from "../../../lib/crawl";
import {
  normalizeDomain,
  clientIp,
  getFreshTeaser,
  saveTeaser,
  recordTeaserHit,
  countHitsForIpLast24h,
  countAllHitsLast24h,
} from "../../../lib/teaser";

export const runtime = "nodejs";
export const maxDuration = 60;

// Public, unauthenticated teaser: shows a taste of the audit before sign-up.
// It exposes only a verdict, a total problem count, and up to 3 problems WITHOUT
// the detailed fix. Full corrections stay behind auth/payment.
const MAX_HITS_PER_IP_24H = 5;
const MAX_HITS_GLOBAL_24H = 200;

const SYSTEM = `${GMC_SKILL}

<role>
You are a strict Google Merchant Center (GMC) compliance auditor running a PUBLIC
TEASER. You are given ONLY public storefront content crawled from the live site
(home page, default Shopify policy pages, contact/about). You have NO product
data, NO Shopify token, NO Merchant Center data.

Audit ONLY what is present in the crawl. Never invent policies, prices, reviews,
delivery times or statuses you were not given. Apply the zero-invention rule.

Return a LIMITED teaser via the report_teaser tool:
- "overall": the go/warning/no-go verdict.
- "issueCount": the TOTAL number of compliance problems you found, even though
  you only detail a few below.
- "teaserIssues": AT MOST 2 of the most important problems, each with only
  "area", "severity" and a short "problem" written in FRENCH. Do NOT include any
  fix, correction, or how-to; that is intentionally withheld from the teaser.

Write "problem" in French, do not use long dashes (use "-"), keep it concise.
Call report_teaser with your findings.
</role>`;

const AREA_ENUM = [
  "product",
  "seo",
  "pricing",
  "images",
  "identity",
  "policy",
  "shipping",
  "returns",
  "claims",
  "theme",
  "needs-verification",
];

const TEASER_TOOL: Anthropic.Tool = {
  name: "report_teaser",
  description:
    "Return a LIMITED public teaser of the GMC compliance audit (no detailed fixes).",
  input_schema: {
    type: "object",
    properties: {
      overall: {
        type: "string",
        enum: ["go", "warning", "no-go"],
        description: "Overall GMC readiness verdict from the public storefront.",
      },
      issueCount: {
        type: "integer",
        description:
          "Total number of compliance problems found, not just the teased ones.",
      },
      teaserIssues: {
        type: "array",
        maxItems: 2,
        description: "At most 2 problems, without the detailed fix.",
        items: {
          type: "object",
          properties: {
            area: { type: "string", enum: AREA_ENUM },
            severity: { type: "string", enum: ["high", "medium", "low"] },
            problem: {
              type: "string",
              description:
                "Short description of the problem, in French. No fix or how-to.",
            },
          },
          required: ["area", "severity", "problem"],
        },
      },
    },
    required: ["overall", "issueCount", "teaserIssues"],
  },
};

type TeaserIssue = { area: string; severity: string; problem: string };
type TeaserResult = {
  domain: string;
  overall: string | null;
  issueCount: number;
  teaserIssues: TeaserIssue[];
  locked: boolean;
  message?: string;
};

export async function POST(req: NextRequest) {
  let body: { url?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonResponse({ error: "invalid_json" }, { status: 400 });
  }

  const domain = normalizeDomain(body.url);
  if (!domain) {
    return jsonResponse({ error: "invalid_url" }, { status: 400 });
  }

  // 1. Cache: a fresh (< 7 days) result short-circuits before any cost.
  const cached = (await getFreshTeaser(domain)) as TeaserResult | null;
  if (cached) {
    return jsonResponse({ ...cached, cached: true });
  }

  // 2. Anti-abuse: per-IP and global caps over the last 24h, before Claude.
  const ip = clientIp(req);
  const [ipHits, globalHits] = await Promise.all([
    countHitsForIpLast24h(ip),
    countAllHitsLast24h(),
  ]);
  if (ipHits >= MAX_HITS_PER_IP_24H || globalHits >= MAX_HITS_GLOBAL_24H) {
    return jsonResponse({ error: "rate_limited" }, { status: 429 });
  }
  await recordTeaserHit(ip);

  // 3. Public crawl only: no Shopify token, no product data.
  let crawl: CrawlResult;
  try {
    crawl = await crawlStorefront(domain, []);
  } catch {
    crawl = { locked: false, pages: [] };
  }

  // 4. Locked store: cannot audit the storefront. Return a clear message.
  if (crawl.locked) {
    const lockedResult: TeaserResult = {
      domain,
      overall: null,
      issueCount: 0,
      teaserIssues: [],
      locked: true,
      message:
        "Cette boutique est protegee par un mot de passe, donc le contenu public " +
        "n'a pas pu etre analyse. Retirez la protection puis relancez l'audit.",
    };
    await saveTeaser(domain, lockedResult);
    return jsonResponse(lockedResult);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return jsonResponse({ error: "server_misconfigured" }, { status: 500 });
  }

  const anthropic = new Anthropic({ apiKey });
  const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";

  try {
    const msg = await anthropic.messages.create({
      model,
      max_tokens: 2000,
      system: SYSTEM,
      tools: [TEASER_TOOL],
      tool_choice: { type: "tool", name: "report_teaser" },
      messages: [
        {
          role: "user",
          content:
            "Public storefront crawl to audit (no product data available):\n\n" +
            JSON.stringify(crawl) +
            "\n\nReturn a limited teaser (French problems, no fixes) via " +
            "report_teaser.",
        },
      ],
    });

    const toolBlock = msg.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    if (!toolBlock) {
      return jsonResponse({ error: "no_structured_output" }, { status: 502 });
    }

    const out = toolBlock.input as {
      overall?: string;
      issueCount?: number;
      teaserIssues?: TeaserIssue[];
    };

    // Hard-cap the teased problems to 2 server-side, whatever the model returns.
    const teaserIssues = (out.teaserIssues ?? [])
      .slice(0, 2)
      .map((i) => ({
        area: i.area,
        severity: i.severity,
        problem: i.problem,
      }));

    const result: TeaserResult = {
      domain,
      overall: out.overall ?? null,
      issueCount:
        typeof out.issueCount === "number"
          ? out.issueCount
          : teaserIssues.length,
      teaserIssues,
      locked: false,
    };

    await saveTeaser(domain, result);
    return jsonResponse(result);
  } catch (err) {
    return jsonResponse(
      { error: "audit_failed", detail: String(err) },
      { status: 502 },
    );
  }
}
