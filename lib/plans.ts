// Usage limits per plan. Starting values, meant to be easy to change.
// No billing wired yet; the plan on a subscription row drives these.

export type PlanId = "free" | "pro";

export type PlanLimits = {
  auditsPerMonth: number;
  canApplyFixes: boolean;
};

export const PLAN_LIMITS: Record<PlanId, PlanLimits> = {
  free: { auditsPerMonth: 3, canApplyFixes: false },
  pro: { auditsPerMonth: 50, canApplyFixes: true },
};

// Any unknown or legacy plan value degrades to the free limits.
export function limitsForPlan(plan: string | null | undefined): PlanLimits {
  return PLAN_LIMITS[(plan ?? "free") as PlanId] ?? PLAN_LIMITS.free;
}

// Start of the current calendar month in UTC, as an ISO string, for the
// "audits this month" count.
export function startOfMonthUtc(now: Date = new Date()): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  ).toISOString();
}
