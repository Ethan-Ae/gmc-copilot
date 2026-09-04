"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";

// --- Audit contract types (see app/api/audits/route.ts) ---
type Overall = "go" | "warning" | "no-go";
type Severity = "high" | "medium" | "low";
type Area =
  | "product"
  | "seo"
  | "pricing"
  | "images"
  | "identity"
  | "policy"
  | "shipping"
  | "returns"
  | "claims"
  | "theme"
  | "needs-verification";

type IssueSource = "site" | "gmc_confirmed" | "both";

interface FixPatch {
  fixType: string;
  field?: string | null;
  targetId?: string | null;
  targetHandle?: string | null;
  // Multi-product fix: same literal phrase removed/replaced across several
  // products (fixType product_seo, field descriptionHtml only).
  targetIds?: string[] | null;
  findText?: string | null;
  replaceText?: string | null;
  currentValue?: string;
  newValue?: string;
  autoApplicable?: boolean;
}

interface Issue {
  area: Area;
  product: string | null;
  severity: Severity;
  source?: IssueSource;
  problem: string;
  fix: string;
  patch?: FixPatch;
}

interface Audit {
  overall: Overall;
  summary: string;
  issues: Issue[];
  checked: string[];
}

interface Entitlements {
  canFullAudit: boolean;
  canApplyFixes: boolean;
  source: string;
}

interface AuditResponse {
  auditId: string;
  shop: string;
  model: string;
  truncated: boolean;
  gmcConnected: boolean;
  audit: Audit;
  entitlements?: Entitlements;
}

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 6 * 60 * 1000;

type State =
  | { status: "idle" }
  | { status: "loading"; progressStep: string | null }
  | { status: "ok"; data: AuditResponse }
  | { status: "not-connected" }
  | { status: "error"; message: string }
  | { status: "timeout" };

// --- Presentation config ---
const VERDICT: Record<
  Overall,
  { label: string; rail: string; chip: string; dot: string }
> = {
  go: {
    label: "Pret pour la review",
    rail: "border-l-go",
    chip: "bg-go-soft text-go",
    dot: "bg-go",
  },
  warning: {
    label: "A corriger avant soumission",
    rail: "border-l-warn",
    chip: "bg-warn-soft text-warn",
    dot: "bg-warn",
  },
  "no-go": {
    label: "Ne pas soumettre en l'etat",
    rail: "border-l-nogo",
    chip: "bg-nogo-soft text-nogo",
    dot: "bg-nogo",
  },
};

const SEVERITY: Record<Severity, { label: string; chip: string }> = {
  high: { label: "Critique", chip: "bg-nogo-soft text-nogo" },
  medium: { label: "Moyen", chip: "bg-warn-soft text-warn" },
  low: { label: "Mineur", chip: "bg-slate-soft text-slate" },
};

// Only a Merchant Center match is worth a badge. "site"-only issues used to
// show a "RISK DETECTED (NOT CONFIRMED)" tag on every single card; that is
// replaced by the single banner at the top of the report (see GmcBanner).
const SOURCE: Partial<Record<IssueSource, { label: string; chip: string }>> = {
  gmc_confirmed: {
    label: "Confirme par Google",
    chip: "bg-nogo-soft text-nogo",
  },
  both: {
    label: "Confirme par Google",
    chip: "bg-nogo-soft text-nogo",
  },
};

const AREA_LABEL: Record<Area, string> = {
  product: "Produit",
  seo: "SEO",
  pricing: "Prix",
  images: "Images",
  identity: "Identite",
  policy: "Politiques",
  shipping: "Livraison",
  returns: "Retours",
  claims: "Allegations",
  theme: "Vitrine",
  "needs-verification": "A verifier",
};

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

function Masthead({ shop }: { shop?: string }) {
  return (
    <header className="border-b border-line-soft bg-surface text-ink">
      <div className="mx-auto w-full max-w-3xl px-5 py-3 flex items-center justify-between gap-4">
        <Link href="/" className="tech-label text-ink">
          Feedcompliant
        </Link>
        <span className="tech-label text-faint truncate">
          {shop ?? "Rapport d'audit"}
        </span>
      </div>
    </header>
  );
}

function ReportInner() {
  const params = useSearchParams();
  const router = useRouter();
  const shop = params.get("shop")?.trim().toLowerCase() ?? "";
  const [state, setState] = useState<State>({ status: "idle" });

  useEffect(() => {
    // No shop in the URL is a navigation mistake, not an audit failure - send
    // the merchant back to the dashboard instead of showing an error screen.
    if (!shop) router.replace("/dashboard");
  }, [shop, router]);
  // Bumped on every retry so a poll loop from a previous attempt stops itself
  // instead of racing the new one.
  const runId = useRef(0);

  const start = useCallback(async () => {
    const myRun = ++runId.current;
    setState({ status: "loading", progressStep: null });

    let auditId: string;
    try {
      const res = await fetch("/api/audits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shop }),
      });
      if (res.status === 404) {
        if (runId.current === myRun) setState({ status: "not-connected" });
        return;
      }
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.auditId) {
        const message =
          (body && (body.detail || body.error)) ||
          `L'audit a échoué (code ${res.status}).`;
        if (runId.current === myRun) setState({ status: "error", message });
        return;
      }
      auditId = body.auditId as string;
    } catch {
      if (runId.current === myRun) {
        setState({
          status: "error",
          message:
            "Impossible de joindre le serveur d'audit. Vérifiez votre connexion et réessayez.",
        });
      }
      return;
    }

    const startedAt = Date.now();

    const poll = async () => {
      if (runId.current !== myRun) return;

      if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
        setState({ status: "timeout" });
        return;
      }

      try {
        const res = await fetch(`/api/audits/${auditId}`);
        if (runId.current !== myRun) return;
        const body = await res.json().catch(() => null);

        if (!res.ok) {
          const message =
            (body && (body.detail || body.error)) ||
            `L'audit a échoué (code ${res.status}).`;
          setState({ status: "error", message });
          return;
        }

        if (body.status === "done") {
          setState({ status: "ok", data: body as AuditResponse });
          return;
        }

        if (body.status === "failed") {
          setState({
            status: "error",
            message: body.error || "L'analyse a échoué.",
          });
          return;
        }

        // queued or running: keep polling and surface the current step.
        setState({ status: "loading", progressStep: body.progressStep ?? null });
        setTimeout(poll, POLL_INTERVAL_MS);
      } catch {
        if (runId.current !== myRun) return;
        setState({
          status: "error",
          message:
            "Impossible de joindre le serveur d'audit. Vérifiez votre connexion et réessayez.",
        });
      }
    };

    setTimeout(poll, POLL_INTERVAL_MS);
  }, [shop]);

  const retry = useCallback(() => {
    void start();
  }, [start]);

  useEffect(() => {
    // start() only calls setState after an await, so no synchronous cascade.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (shop) void start();
  }, [shop, start]);

  return (
    <main className="flex-1 flex flex-col">
      <Masthead shop={shop || undefined} />
      <div className="mx-auto w-full max-w-3xl px-5 py-10 flex-1">
        {state.status === "idle" && <LoadingView progressStep={null} />}
        {state.status === "loading" && (
          <LoadingView progressStep={state.progressStep} />
        )}
        {state.status === "not-connected" && <NotConnectedView shop={shop} />}
        {state.status === "error" && (
          <ErrorView message={state.message} onRetry={retry} />
        )}
        {state.status === "timeout" && (
          <ErrorView
            message="L'audit prend plus de temps que prevu et a ete interrompu. Reessaie dans un instant."
            onRetry={retry}
          />
        )}
        {state.status === "ok" && (
          <ResultView data={state.data} onRetry={retry} />
        )}
      </div>
    </main>
  );
}

function LoadingView({ progressStep }: { progressStep: string | null }) {
  return (
    <section className="rise max-w-lg mx-auto text-center py-16">
      <p className="tech-label text-brand mb-4">Inspection en cours</p>
      <h1 className="text-2xl font-semibold tracking-tight">
        Analyse de votre boutique en cours
      </h1>
      {progressStep && (
        <p className="mt-2 tech-label text-faint" role="status">
          {progressStep}
        </p>
      )}
      <p className="mt-3 text-muted leading-relaxed">
        Nous lisons vos données produit et les confrontons aux règles Google
        Merchant Center. Cela peut prendre jusqu&apos;à quelques minutes sur
        une grande boutique. Restez sur la page.
      </p>
      <div className="scan-track h-1 rounded-full mt-8" aria-hidden="true" />
      <p className="sr-only" role="status">
        Audit en cours, patientez.
      </p>
    </section>
  );
}

function NotConnectedView({ shop }: { shop: string }) {
  return (
    <section className="rise max-w-lg mx-auto py-10">
      <p className="tech-label text-warn mb-4">Boutique non connectee</p>
      <h1 className="text-2xl font-semibold tracking-tight">
        On n&apos;a pas encore acces a cette boutique.
      </h1>
      <p className="mt-3 text-muted leading-relaxed">
        Pour auditer{" "}
        <span className="font-mono text-ink">{shop || "ta boutique"}</span>, on
        a besoin d&apos;une connexion Shopify. C&apos;est une autorisation en
        lecture, revocable a tout moment.
      </p>
      {shop && (
        <a
          href={`/api/shopify/auth?shop=${encodeURIComponent(shop)}`}
          className="inline-flex mt-8 bg-ink hover:bg-white text-paper font-medium rounded-full px-8 py-4 transition-colors"
        >
          Connecter Shopify
        </a>
      )}
    </section>
  );
}

function ErrorView({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <section className="rise max-w-lg mx-auto py-10">
      <p className="tech-label text-nogo mb-4">Audit interrompu</p>
      <h1 className="text-2xl font-semibold tracking-tight">
        L&apos;audit n&apos;a pas abouti.
      </h1>
      <p className="mt-4 border-l-2 border-l-nogo bg-nogo-soft/60 rounded-r-xl px-4 py-3 font-mono text-sm text-ink">
        {message}
      </p>
      <p className="mt-4 text-muted leading-relaxed">
        Vérifiez le domaine de la boutique, puis relancez. Si le problème
        persiste, réessayez dans une minute - l&apos;analyse peut prendre plus
        de temps si la boutique est lente à répondre.
      </p>
      <button
        onClick={onRetry}
        className="mt-8 bg-ink hover:bg-white text-paper font-medium rounded-full px-8 py-4 transition-colors"
      >
        Réessayer
      </button>
    </section>
  );
}

// Shown once at the top of the report instead of a per-issue "not confirmed"
// tag: the site-detected risks below have not been cross-checked against real
// Merchant Center account issues.
function GmcBanner() {
  return (
    <div className="rounded-2xl border border-line bg-ink-soft px-4 py-3 text-sm text-muted">
      Connectez Google Merchant Center pour croiser ces risques avec les
      signalements reels de Google.{" "}
      <Link href="/dashboard" className="text-brand underline">
        Connecter Google Merchant Center
      </Link>
    </div>
  );
}

function ResultView({
  data,
  onRetry,
}: {
  data: AuditResponse;
  onRetry: () => void;
}) {
  const { audit } = data;
  const verdict = VERDICT[audit.overall] ?? VERDICT.warning;
  const issues = [...audit.issues].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
  // Fix actions require full rights. When entitlements are absent (older
  // response), default to allowed - the /api/fix route still enforces access
  // server-side, so a stale-true here is refused with a 403 on click.
  const canApplyFixes = data.entitlements?.canApplyFixes ?? true;
  const autoPatches = issues
    .map((issue) => issue.patch)
    .filter((p): p is FixPatch => Boolean(p?.autoApplicable));

  return (
    <div className="rise space-y-8">
      {!data.gmcConnected && <GmcBanner />}

      {/* Verdict panel */}
      <section
        className={`bg-ink-soft border border-line ${verdict.rail} border-l-4 rounded-2xl p-6`}
      >
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <p className="tech-label text-faint mb-2">Verdict</p>
            <div className="flex items-center gap-2.5">
              <span
                className={`inline-block h-2.5 w-2.5 rounded-full ${verdict.dot}`}
                aria-hidden="true"
              />
              <h1 className="text-2xl font-semibold tracking-tight">
                {verdict.label}
              </h1>
            </div>
          </div>
          <button
            onClick={onRetry}
            className="shrink-0 border border-line-strong hover:border-brand hover:text-brand text-ink font-medium rounded-full px-4 py-2 text-sm transition-colors"
          >
            Relancer l&apos;audit
          </button>
        </div>
        <p className="mt-5 text-muted leading-relaxed">{audit.summary}</p>
        <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-1 tech-label text-faint">
          <span>{data.shop}</span>
          <span aria-hidden="true">/</span>
          <span>
            {issues.length} probleme{issues.length > 1 ? "s" : ""}
          </span>
          {data.truncated && (
            <>
              <span aria-hidden="true">/</span>
              <span className="text-warn">Rapport tronque</span>
            </>
          )}
        </div>
      </section>

      {/* Issues */}
      <section>
        <div className="flex items-center justify-between gap-4 flex-wrap mb-4">
          <h2 className="tech-label text-faint">
            Problemes detectes ({issues.length})
          </h2>
          {canApplyFixes && autoPatches.length > 0 && (
            <FixAllActions
              shop={data.shop}
              auditId={data.auditId}
              patches={autoPatches}
            />
          )}
        </div>
        {issues.length === 0 ? (
          <p className="bg-ink-soft border border-line rounded-2xl p-6 text-muted">
            Aucun probleme detecte sur les donnees inspectees.
          </p>
        ) : (
          <ul className="space-y-4">
            {issues.map((issue, i) => (
              <IssueCard
                key={i}
                issue={issue}
                shop={data.shop}
                auditId={data.auditId}
                canApplyFixes={canApplyFixes}
              />
            ))}
          </ul>
        )}
      </section>

      {/* Checked */}
      {audit.checked?.length > 0 && (
        <section>
          <h2 className="tech-label text-faint mb-4">
            Points verifies ({audit.checked.length})
          </h2>
          <ul className="flex flex-wrap gap-2">
            {audit.checked.map((c, i) => (
              <li
                key={i}
                className="inline-flex items-center gap-2 bg-ink-soft border border-line rounded-full px-3 py-1.5 font-mono text-xs text-muted"
              >
                <span className="text-go" aria-hidden="true">
                  &#10003;
                </span>
                {c}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// "Tout corriger": applies every auto-applicable patch in sequence, one write
// at a time, and shows a recap. Runs independently of each IssueCard's own
// Previsualiser/Appliquer buttons, which remain available per-issue. A
// multi-product patch (targetIds) counts each product individually in the
// recap, not the single issue it came from.
function FixAllActions({
  shop,
  auditId,
  patches,
}: {
  shop: string;
  auditId: string;
  patches: FixPatch[];
}) {
  const [running, setRunning] = useState(false);
  const [recap, setRecap] = useState<{
    applied: number;
    skipped: { patch: FixPatch; reason: string }[];
  } | null>(null);

  const runAll = async () => {
    setRunning(true);
    setRecap(null);
    let applied = 0;
    const skipped: { patch: FixPatch; reason: string }[] = [];

    for (const patch of patches) {
      try {
        const res = await fetch("/api/fix", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ shop, patch, mode: "apply", auditId }),
        });
        const body = await res.json().catch(() => null);

        // Multi-product fix: the response counts individual products, not
        // one outcome for the whole issue.
        if (res.ok && body?.status === "applied" && body?.multi) {
          applied += body.appliedCount ?? 0;
          for (const s of (body.skipped ?? []) as { reason: string }[]) {
            skipped.push({ patch, reason: s.reason });
          }
          continue;
        }

        if (res.ok && body?.status === "applied") {
          applied += 1;
          continue;
        }

        let reason: string;
        if (body?.status === "drift") {
          reason = "Modifie depuis l'audit - relancez un audit.";
        } else {
          reason =
            (body?.userErrors?.length &&
              body.userErrors.map((e: { message: string }) => e.message).join(" ")) ||
            body?.message ||
            body?.error ||
            "Une erreur est survenue.";
        }
        skipped.push({ patch, reason });
      } catch {
        skipped.push({ patch, reason: "Le serveur est injoignable." });
      }
    }

    setRecap({ applied, skipped });
    setRunning(false);
  };

  return (
    <div className="flex flex-col items-end gap-2">
      <button
        onClick={runAll}
        disabled={running}
        className="bg-ink text-paper hover:bg-white font-medium rounded-full px-4 py-2 text-sm transition-colors disabled:opacity-50"
      >
        {running ? "Application en cours..." : `Tout corriger (${patches.length})`}
      </button>
      {recap && (
        <p className="text-sm text-muted text-right">
          {recap.applied} applique{recap.applied > 1 ? "s" : ""}, {recap.skipped.length}{" "}
          ignore{recap.skipped.length > 1 ? "s" : ""}
          {recap.skipped.length > 0 && (
            <>
              {" "}
              (
              {recap.skipped
                .map((s) => s.reason)
                .filter((r, i, arr) => arr.indexOf(r) === i)
                .join(", ")}
              )
            </>
          )}
          . Recharge la page pour voir les correctifs a jour.
        </p>
      )}
    </div>
  );
}

function IssueCard({
  issue,
  shop,
  auditId,
  canApplyFixes,
}: {
  issue: Issue;
  shop: string;
  auditId: string;
  canApplyFixes: boolean;
}) {
  const sev = SEVERITY[issue.severity] ?? SEVERITY.low;
  const sourceBadge = issue.source ? SOURCE[issue.source] : undefined;
  return (
    <li className="bg-ink-soft border border-line rounded-2xl p-5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`tech-label rounded-full px-2 py-1 ${sev.chip}`}>
          {sev.label}
        </span>
        <span className="tech-label rounded-full px-2 py-1 bg-slate-soft text-slate">
          {AREA_LABEL[issue.area] ?? issue.area}
        </span>
        {sourceBadge && (
          <span className={`tech-label rounded-full px-2 py-1 ${sourceBadge.chip}`}>
            {sourceBadge.label}
          </span>
        )}
        {issue.product && (
          <span className="font-mono text-xs text-muted truncate">
            {issue.product}
          </span>
        )}
      </div>
      <p className="mt-3 text-ink leading-relaxed">{issue.problem}</p>
      <div className="mt-4 border-l-2 border-l-brand bg-brand-soft/70 rounded-r-xl px-4 py-3">
        <p className="tech-label text-brand mb-1">Correctif</p>
        <p className="text-ink leading-relaxed">{issue.fix}</p>
      </div>
      {issue.patch?.autoApplicable ? (
        canApplyFixes ? (
          <FixActions shop={shop} auditId={auditId} patch={issue.patch} />
        ) : (
          <FixLocked />
        )
      ) : (
        <ManualFix />
      )}
    </li>
  );
}

// Issues whose patch is not auto-applicable (fixType "manual_only", "theme",
// "page", "business_identity", or no patch at all) never get a write button -
// only the "Correctif" text above, which already carries the exact steps.
function ManualFix() {
  return (
    <div className="mt-4 border-t border-line pt-4">
      <p className="tech-label text-faint">
        A corriger manuellement dans Shopify Admin, voir le correctif ci-dessus.
      </p>
    </div>
  );
}

// Shown when the audited shop has no full access (never unlocked, or the 30-day
// window has elapsed). The report itself stays fully visible; only the write
// workflow is gated. The Previsualiser/Appliquer buttons are rendered disabled
// beside the same expired-access banner the dashboard uses. The /api/fix route
// enforces this server-side regardless of what the UI renders.
function FixLocked() {
  return (
    <div className="mt-4 border-t border-line pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled
          aria-disabled="true"
          className="border border-line-strong text-ink font-medium rounded-full px-3 py-1.5 text-sm opacity-50 cursor-not-allowed"
        >
          Previsualiser
        </button>
        <button
          type="button"
          disabled
          aria-disabled="true"
          className="bg-ink text-paper font-medium rounded-full px-3 py-1.5 text-sm opacity-50 cursor-not-allowed"
        >
          Appliquer
        </button>
      </div>
      <div className="mt-3 rounded-xl border border-warn/40 bg-warn-soft/50 p-3">
        <p className="text-sm text-ink">
          Votre acces est expire. Relancez une mise en conformite pour appliquer
          des correctifs.
        </p>
        <Link
          href="/dashboard"
          className="tech-label mt-3 inline-block rounded-full bg-ink px-3 py-1.5 text-paper hover:bg-white"
        >
          Relancer la mise en conformite
        </Link>
      </div>
    </div>
  );
}

// Local, per-issue fix workflow: preview (read-only), apply (write), then undo.
// All state lives in useState here; nothing is persisted to the browser.
type PreviewResult = {
  kind: "preview";
  currentLive: string | null;
  newValue: string;
  drift: boolean;
};
type AppliedResult = { kind: "applied"; fixId: string; newValue: string };
type DriftResult = { kind: "drift"; currentLive: string | null };
type ErrorResult = { kind: "error"; message: string };
type RevertedResult = { kind: "reverted" };
type MultiPreviewResult = { kind: "multi-preview"; targetCount: number; foundCount: number };
type MultiAppliedResult = {
  kind: "multi-applied";
  appliedCount: number;
  skippedCount: number;
  skipped: { targetId: string; reason: string }[];
};
type FixResult =
  | PreviewResult
  | AppliedResult
  | DriftResult
  | ErrorResult
  | RevertedResult
  | MultiPreviewResult
  | MultiAppliedResult;

function FixActions({
  shop,
  auditId,
  patch,
}: {
  shop: string;
  auditId: string;
  patch: FixPatch;
}) {
  const [busy, setBusy] = useState<null | "preview" | "apply" | "revert">(null);
  const [result, setResult] = useState<FixResult | null>(null);

  const userErrorsText = (body: unknown): string => {
    const errs = (body as { userErrors?: { message: string }[] })?.userErrors;
    if (errs?.length) return errs.map((e) => e.message).join(" ");
    // Prefer a human message (e.g. the 403 acces_expire payload) over the raw
    // error slug, so a gated response reads cleanly instead of showing a code.
    const b = body as { message?: string; detail?: string; error?: string };
    return b?.message || b?.detail || b?.error || "Une erreur est survenue.";
  };

  const preview = async () => {
    setBusy("preview");
    try {
      const res = await fetch("/api/fix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shop, patch, mode: "preview", auditId }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setResult({ kind: "error", message: userErrorsText(body) });
        return;
      }
      if (body?.multi) {
        const results = (body.results ?? []) as { found: boolean }[];
        setResult({
          kind: "multi-preview",
          targetCount: body.targetCount ?? results.length,
          foundCount: results.filter((r) => r.found).length,
        });
        return;
      }
      setResult({
        kind: "preview",
        currentLive: body.currentLive ?? null,
        newValue: body.newValue ?? patch.newValue ?? "",
        drift: Boolean(body.drift),
      });
    } catch {
      setResult({ kind: "error", message: "Le serveur est injoignable." });
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    setBusy("apply");
    try {
      const res = await fetch("/api/fix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shop, patch, mode: "apply", auditId }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.status === "applied" && body?.multi) {
        setResult({
          kind: "multi-applied",
          appliedCount: body.appliedCount ?? 0,
          skippedCount: body.skippedCount ?? 0,
          skipped: body.skipped ?? [],
        });
        return;
      }
      if (res.ok && body?.status === "applied") {
        setResult({
          kind: "applied",
          fixId: body.fixId,
          newValue: body.newValue ?? patch.newValue ?? "",
        });
        return;
      }
      if (body?.status === "drift") {
        setResult({ kind: "drift", currentLive: body.currentLive ?? null });
        return;
      }
      setResult({ kind: "error", message: userErrorsText(body) });
    } catch {
      setResult({ kind: "error", message: "Le serveur est injoignable." });
    } finally {
      setBusy(null);
    }
  };

  const revert = async (fixId: string) => {
    setBusy("revert");
    try {
      const res = await fetch("/api/fix/revert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fixHistoryId: fixId }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.status === "reverted") {
        setResult({ kind: "reverted" });
        return;
      }
      if (body?.status === "drift") {
        setResult({ kind: "drift", currentLive: body.currentLive ?? null });
        return;
      }
      setResult({ kind: "error", message: userErrorsText(body) });
    } catch {
      setResult({ kind: "error", message: "Le serveur est injoignable." });
    } finally {
      setBusy(null);
    }
  };

  const applied = result?.kind === "applied" ? result : null;
  const finished = result?.kind === "reverted" || result?.kind === "multi-applied";

  return (
    <div className="mt-4 border-t border-line pt-4">
      <div className="flex flex-wrap items-center gap-2">
        {!applied && !finished && (
          <>
            <button
              onClick={preview}
              disabled={busy !== null}
              className="border border-line-strong hover:border-brand hover:text-brand text-ink font-medium rounded-full px-3 py-1.5 text-sm transition-colors disabled:opacity-50"
            >
              {busy === "preview" ? "Chargement..." : "Previsualiser"}
            </button>
            <button
              onClick={apply}
              disabled={busy !== null}
              className="bg-ink text-paper hover:bg-white font-medium rounded-full px-3 py-1.5 text-sm transition-colors disabled:opacity-50"
            >
              {busy === "apply" ? "Application..." : "Appliquer"}
            </button>
          </>
        )}
        {applied && (
          <button
            onClick={() => revert(applied.fixId)}
            disabled={busy !== null}
            className="border border-line-strong hover:border-nogo hover:text-nogo text-ink font-medium rounded-full px-3 py-1.5 text-sm transition-colors disabled:opacity-50"
          >
            {busy === "revert" ? "Annulation..." : "Annuler"}
          </button>
        )}
      </div>

      {result?.kind === "preview" && (
        <div className="mt-3 text-sm space-y-1">
          <p className="text-muted">
            <span className="tech-label text-faint">Actuel</span> :{" "}
            <span className="text-ink">{result.currentLive || "(vide)"}</span>
          </p>
          <p className="text-muted">
            <span className="tech-label text-faint">Propose</span> :{" "}
            <span className="text-ink">{result.newValue || "(vide)"}</span>
          </p>
          {result.drift && (
            <p className="text-warn font-medium">
              Modifie depuis l&apos;audit
            </p>
          )}
        </div>
      )}

      {result?.kind === "applied" && (
        <p className="mt-3 text-sm text-go font-medium">Applique</p>
      )}

      {result?.kind === "reverted" && (
        <p className="mt-3 text-sm text-muted">Correction annulee.</p>
      )}

      {result?.kind === "drift" && (
        <p className="mt-3 text-sm text-warn font-medium">
          Ce champ a ete modifie depuis l&apos;audit - relancez un audit.
        </p>
      )}

      {result?.kind === "error" && (
        <p className="mt-3 text-sm text-nogo">{result.message}</p>
      )}

      {result?.kind === "multi-preview" && (
        <p className="mt-3 text-sm text-muted">
          Concerne {result.targetCount} produit{result.targetCount > 1 ? "s" : ""}, dont{" "}
          {result.foundCount} avec la phrase encore presente.
        </p>
      )}

      {result?.kind === "multi-applied" && (
        <p className="mt-3 text-sm text-go font-medium">
          {result.appliedCount} produit{result.appliedCount > 1 ? "s" : ""} corrige
          {result.appliedCount > 1 ? "s" : ""}
          {result.skippedCount > 0 && (
            <span className="block text-warn font-normal mt-1">
              {result.skippedCount} ignore{result.skippedCount > 1 ? "s" : ""} :{" "}
              {result.skipped
                .map((s) => s.reason)
                .filter((r, i, arr) => arr.indexOf(r) === i)
                .join(", ")}
            </span>
          )}
        </p>
      )}
    </div>
  );
}

export default function ReportPage() {
  return (
    <Suspense fallback={<LoadingShell />}>
      <ReportInner />
    </Suspense>
  );
}

function LoadingShell() {
  return (
    <main className="flex-1 flex flex-col">
      <Masthead />
      <div className="mx-auto w-full max-w-3xl px-5 py-10 flex-1">
        <LoadingView progressStep={null} />
      </div>
    </main>
  );
}
