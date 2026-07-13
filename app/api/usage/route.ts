import { auth } from "@clerk/nextjs/server";
import { jsonResponse } from "../../../lib/apiJson";
import { getOrCreateSubscription } from "../../../lib/subscriptions";
import { limitsForPlan, startOfMonthUtc } from "../../../lib/plans";
import { countAuditsForUserSince } from "../../../lib/audits";

export const runtime = "nodejs";

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return jsonResponse({ error: "Unauthorized" }, { status: 401 });
  }

  const sub = await getOrCreateSubscription(userId);
  const limits = limitsForPlan(sub.plan);
  const auditsUsed = await countAuditsForUserSince(userId, startOfMonthUtc());

  return jsonResponse({
    plan: sub.plan,
    auditsUsed,
    auditsLimit: limits.auditsPerMonth,
    canApplyFixes: limits.canApplyFixes,
  });
}
