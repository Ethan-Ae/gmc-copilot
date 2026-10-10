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
  // True when the shipping/markets Shopify read was refused for lacking
  // scope (see lib/auditEngine.ts's needsReauth). Optional so an older
  // cached response without the field just does not show the banner.
  needsReauth?: boolean;
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
  | { status: "quota-reached" }
  | { status: "reauth-required" }
  | { status: "error"; message: string }
  | { status: "timeout" };

// --- Presentation config ---
const VERDICT: Record<
  Overall,
  { label: string; rail: string; chip: string; dot: string }
> = {
  go: {
    label: "Prêt pour la review",
    rail: "border-l-go",
    chip: "bg-go-soft text-go",
    dot: "bg-go",
  },
  warning: {
    label: "À corriger avant soumission",
    rail: "border-l-warn",
    chip: "bg-warn-soft text-warn",
    dot: "bg-warn",
  },
  "no-go": {
    label: "Ne pas soumettre en l'état",
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
    label: "Confirmé par Google",
    chip: "bg-nogo-soft text-nogo",
  },
  both: {
    label: "Confirmé par Google",
    chip: "bg-nogo-soft text-nogo",
  },
};

const AREA_LABEL: Record<Area, string> = {
  product: "Produit",
  seo: "SEO",
  pricing: "Prix",
  images: "Images",
  identity: "Identité",
  policy: "Politiques",
  shipping: "Livraison",
  returns: "Retours",
  claims: "Allégations",
  theme: "Vitrine",
  "needs-verification": "À vérifier",
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

function ReportInner({ appStoreUrl }: { appStoreUrl: string }) {
  const params = useSearchParams();
  const router = useRouter();
  const shop = params.get("shop")?.trim().toLowerCase() ?? "";
  const [state, setState] = useState<State>({ status: "idle" });

  // A /report opened with no "shop" param at all (broken/hand-edited link)
  // has nothing to audit: send the merchant to the dashboard to pick a shop
  // instead of showing a dead page.
  useEffect(() => {
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
        // audit_limit_reached (quota) and shopify_reauth_required (dead
        // Shopify token) are normal product states, not audit failures: they
        // get their own view with the right call to action instead of the
        // generic ErrorView, and their raw slug is never shown to the
        // merchant.
        if (res.status === 402 && body?.error === "audit_limit_reached") {
          if (runId.current === myRun) setState({ status: "quota-reached" });
          return;
        }
        if (res.status === 401 && body?.error === "shopify_reauth_required") {
          if (runId.current === myRun) setState({ status: "reauth-required" });
          return;
        }
        // Any other failure (auth/ownership/edge cases): never render
        // body.detail/body.error verbatim, just the status code.
        const message = `L'audit a échoué (code ${res.status}).`;
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
          // Never render body.detail/body.error verbatim (e.g. "not_found" if
          // the row becomes inaccessible mid-poll), just the status code.
          setState({ status: "error", message: `L'audit a échoué (code ${res.status}).` });
          return;
        }

        if (body.status === "done") {
          setState({ status: "ok", data: body as AuditResponse });
          return;
        }

        if (body.status === "failed") {
          // A mid-run Shopify token failure (dead/revoked token) is the same
          // reconnect product state as the preflight check above, not a
          // generic analysis failure - see lib/auditErrors.ts's AuditErrorCode.
          if (body.code === "shopify_auth") {
            setState({ status: "reauth-required" });
            return;
          }
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
        {shop && state.status === "idle" && <LoadingView progressStep={null} />}
        {shop && state.status === "loading" && (
          <LoadingView progressStep={state.progressStep} />
        )}
        {shop && state.status === "not-connected" && (
          <NotConnectedView shop={shop} appStoreUrl={appStoreUrl} />
        )}
        {shop && state.status === "quota-reached" && (
          <QuotaReachedView shop={shop} />
        )}
        {shop && state.status === "reauth-required" && (
          <ReauthRequiredView appStoreUrl={appStoreUrl} />
        )}
        {shop && state.status === "error" && (
          <ErrorView message={state.message} onRetry={retry} />
        )}
        {shop && state.status === "timeout" && (
          <ErrorView
            message="L'audit prend plus de temps que prévu et a été interrompu. Réessaie dans un instant."
            onRetry={retry}
          />
        )}
        {shop && state.status === "ok" && (
          <ResultView data={state.data} onRetry={retry} appStoreUrl={appStoreUrl} />
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

function NotConnectedView({
  shop,
  appStoreUrl,
}: {
  shop: string;
  appStoreUrl: string;
}) {
  return (
    <section className="rise max-w-lg mx-auto py-10">
      <p className="tech-label text-warn mb-4">Boutique non connectée</p>
      <h1 className="text-2xl font-semibold tracking-tight">
        On n&apos;a pas encore accès à cette boutique.
      </h1>
      <p className="mt-3 text-muted leading-relaxed">
        Pour auditer{" "}
        <span className="font-mono text-ink">{shop || "ta boutique"}</span>, on
        a besoin d&apos;une connexion Shopify. C&apos;est une autorisation en
        lecture, révocable à tout moment.
      </p>
      <a
        href={appStoreUrl}
        className="inline-flex mt-8 bg-ink hover:bg-white text-paper font-medium rounded-full px-8 py-4 transition-colors"
      >
        Réinstallez Feedcompliant depuis le Shopify App Store pour reconnecter
        cette boutique.
      </a>
    </section>
  );
}

// Shared purchase-flow trigger: runs the exact same Shopify Billing charge as
// the dashboard's "Debloquer"/"Relancer" button (see
// app/dashboard/ShopBilling.tsx's start()). Reused everywhere the app needs
// to turn an entitlement gap (quota reached, access expired) into a purchase
// CTA, so the mechanic - and its failure wording - only lives in one place.
function UnlockButton({
  shop,
  label,
  redirectingLabel = "Redirection...",
  billingUrl = "/api/shopify/billing/start",
  returnPath,
  className,
}: {
  shop: string;
  label: string;
  redirectingLabel?: string;
  billingUrl?: string;
  // Where Shopify sends the merchant back after accepting/declining the
  // charge (see app/api/shopify/billing/return/route.ts). Defaults to the
  // dashboard when omitted; the report page passes its own URL so "Appliquer"
  // is immediately usable on return instead of landing on the dashboard.
  returnPath?: string;
  className: string;
}) {
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const unlock = async () => {
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch(billingUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shop, type: "one_time", returnPath }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.confirmationUrl) {
        window.location.href = body.confirmationUrl as string;
        return;
      }
      // Deliberately never rendered from body.error/body.detail: whatever the
      // billing route failed with, the merchant only ever sees this fixed
      // sentence.
      setActionError("La création du paiement a échoué. Réessayez.");
    } catch {
      setActionError("Le serveur est injoignable.");
    }
    setBusy(false);
  };

  return (
    <>
      <button type="button" onClick={unlock} disabled={busy} className={className}>
        {busy ? redirectingLabel : label}
      </button>
      {actionError && <p className="mt-3 text-sm text-nogo">{actionError}</p>}
    </>
  );
}

// Shown when POST /api/audits returns audit_limit_reached (402): the free
// monthly quota is exhausted. This is a normal product state, not a failure -
// no "Réessayer" button (retrying does nothing until the merchant unlocks
// full access), and the raw "audit_limit_reached" slug is never rendered.
function QuotaReachedView({ shop }: { shop: string }) {
  return (
    <section className="rise max-w-lg mx-auto py-10">
      <p className="tech-label text-warn mb-4">Quota atteint</p>
      <h1 className="text-2xl font-semibold tracking-tight">
        Limite d&apos;audits gratuits atteinte
      </h1>
      <p className="mt-3 text-muted leading-relaxed">
        Débloquez la mise en conformité pour auditer cette boutique et
        appliquer les correctifs.
      </p>
      <div className="mt-8">
        <UnlockButton
          shop={shop}
          label="Débloquer - 149 CHF via Shopify"
          className="inline-flex bg-ink hover:bg-white text-paper font-medium rounded-full px-8 py-4 transition-colors disabled:opacity-60"
        />
      </div>
    </section>
  );
}

// Shown when the Shopify token is dead/revoked, either caught before the
// audit starts (POST /api/audits -> shopify_reauth_required) or mid-run (GET
// /api/audits/[id] -> status "failed", code "shopify_auth"). Per App Review
// 2.3.2, /api/shopify/auth only starts OAuth for a shop already validated by
// a real signed Shopify launch (see the hardened HMAC gate in
// app/api/shopify/auth/route.ts) - reconnecting can no longer be a link
// within the app, only a fresh install from the Shopify App Store. No
// "Réessayer" button: retrying against a dead token fails the same way again.
function ReauthRequiredView({ appStoreUrl }: { appStoreUrl: string }) {
  return (
    <section className="rise max-w-lg mx-auto py-10">
      <p className="tech-label text-warn mb-4">Reconnexion nécessaire</p>
      <h1 className="text-2xl font-semibold tracking-tight">
        La connexion à votre boutique a expiré.
      </h1>
      <p className="mt-3 text-muted leading-relaxed">
        Réinstallez Feedcompliant depuis le Shopify App Store pour reconnecter
        cette boutique et relancer l&apos;audit.
      </p>
      <a
        href={appStoreUrl}
        className="inline-flex mt-8 bg-ink hover:bg-white text-paper font-medium rounded-full px-8 py-4 transition-colors"
      >
        Réinstaller depuis le Shopify App Store
      </a>
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
      signalements réels de Google.{" "}
      <Link href="/dashboard" className="text-brand underline">
        Connecter Google Merchant Center
      </Link>
    </div>
  );
}

// Shown once at the top of the report when the shipping/markets read was
// refused for lacking scope: this app manages its own OAuth (legacy install
// flow), so Shopify never auto-upgrades an already-installed shop's granted
// scopes. Per App Review 2.3.2, /api/shopify/auth only starts OAuth for a
// shop already validated by a real signed Shopify launch - it can no longer
// be called directly from the app with a bare shop param (see the hardened
// HMAC gate in app/api/shopify/auth/route.ts), so reconnecting must go
// through a fresh install from the Shopify App Store instead. The audit
// above still ran and is still usable; this only affects shipping-policy
// cross-checks against real zones/markets.
function ReauthBanner({ appStoreUrl }: { appStoreUrl: string }) {
  return (
    <div className="rounded-2xl border border-line bg-ink-soft px-4 py-3 text-sm text-muted">
      Cette boutique a été connectée avant l&apos;ajout des autorisations
      livraison et marchés - certains contrôles (zones, pays, devises)
      n&apos;ont pas pu être vérifiés.{" "}
      <a href={appStoreUrl} className="text-brand underline">
        Réinstallez Feedcompliant depuis le Shopify App Store pour reconnecter
        cette boutique.
      </a>
    </div>
  );
}

function ResultView({
  data,
  onRetry,
  appStoreUrl,
}: {
  data: AuditResponse;
  onRetry: () => void;
  appStoreUrl: string;
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
      {data.needsReauth && <ReauthBanner appStoreUrl={appStoreUrl} />}

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
            {issues.length} problème{issues.length > 1 ? "s" : ""}
          </span>
          {data.truncated && (
            <>
              <span aria-hidden="true">/</span>
              <span className="text-warn">Rapport tronqué</span>
            </>
          )}
        </div>
      </section>

      {/* Issues */}
      <section>
        <div className="flex items-center justify-between gap-4 flex-wrap mb-4">
          <h2 className="tech-label text-faint">
            Problèmes détectés ({issues.length})
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
            Aucun problème détecté sur les données inspectées.
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
                onRetryAudit={onRetry}
              />
            ))}
          </ul>
        )}
      </section>

      {/* Checked */}
      {audit.checked?.length > 0 && (
        <section>
          <h2 className="tech-label text-faint mb-4">
            Points vérifiés ({audit.checked.length})
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
  // payment_required/reauth_required apply identically to every remaining
  // patch (entitlement/token are checked once per shop, not per patch), so
  // the loop stops on first occurrence instead of accumulating N duplicate
  // reasons - the recap is replaced by the one CTA that actually unblocks it.
  const [blocked, setBlocked] = useState<PaymentRequiredResult | ReauthRequiredResult | null>(
    null,
  );

  const runAll = async () => {
    setRunning(true);
    setRecap(null);
    setBlocked(null);
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
        // one outcome for the whole issue. "partial" (some but not all
        // targets written) counts the same way as a full "applied" - only
        // "failed"/nothing_applied (appliedCount 0) falls through below.
        if (
          res.ok &&
          (body?.status === "applied" || body?.status === "partial") &&
          body?.multi
        ) {
          applied += body.appliedCount ?? 0;
          for (const s of (body.skipped ?? []) as { reason: string }[]) {
            skipped.push({ patch, reason: fixReasonMessage(s.reason) });
          }
          continue;
        }

        if (res.ok && body?.status === "applied") {
          applied += 1;
          continue;
        }

        const shared = sharedFixOutcome(res, body);
        if (shared?.kind === "payment-required" || shared?.kind === "reauth-required") {
          setBlocked(shared);
          setRunning(false);
          return;
        }

        let reason: string;
        if (body?.status === "drift") {
          reason = "Modifié depuis l'audit - relancez un audit.";
        } else if (shared?.kind === "failed") {
          reason = shared.message;
        } else {
          reason =
            (body?.userErrors?.length &&
              body.userErrors.map((e: { message: string }) => e.message).join(" ")) ||
            fixErrorMessage(body);
        }
        skipped.push({ patch, reason });
      } catch {
        skipped.push({ patch, reason: "Le serveur est injoignable." });
      }
    }

    setRecap({ applied, skipped });
    setRunning(false);
  };

  if (blocked?.kind === "payment-required") {
    return (
      <div className="rounded-xl border border-warn/40 bg-warn-soft/50 p-3 max-w-xs">
        <p className="text-sm text-ink">{blocked.message}</p>
        <div className="mt-3">
          <UnlockButton
            shop={shop}
            billingUrl={blocked.billingUrl}
            returnPath={`/report?shop=${encodeURIComponent(shop)}`}
            label="Débloquer les corrections"
            className="tech-label rounded-full bg-ink px-3 py-1.5 text-paper hover:bg-white disabled:opacity-60"
          />
        </div>
      </div>
    );
  }

  if (blocked?.kind === "reauth-required") {
    return (
      <div className="rounded-xl border border-warn/40 bg-warn-soft/50 p-3 max-w-xs">
        <p className="text-sm text-ink">
          La connexion à Shopify a expiré. Réinstallez l&apos;app pour
          reconnecter cette boutique.
        </p>
        <a
          href={blocked.reauthUrl}
          className="tech-label mt-3 inline-block rounded-full bg-ink px-3 py-1.5 text-paper hover:bg-white"
        >
          Se reconnecter via le Shopify App Store
        </a>
      </div>
    );
  }

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
          {recap.applied} appliqué{recap.applied > 1 ? "s" : ""}, {recap.skipped.length}{" "}
          ignoré{recap.skipped.length > 1 ? "s" : ""}
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
  onRetryAudit,
}: {
  issue: Issue;
  shop: string;
  auditId: string;
  canApplyFixes: boolean;
  onRetryAudit: () => void;
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
          <FixActions
            shop={shop}
            auditId={auditId}
            patch={issue.patch}
            onRetryAudit={onRetryAudit}
          />
        ) : (
          <FixLocked shop={shop} />
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
        À corriger manuellement dans Shopify Admin, voir le correctif ci-dessus.
      </p>
    </div>
  );
}

// Shown when the audited shop has no full access (never unlocked, or the
// 30-day window has elapsed). The report itself stays fully visible; only the
// write workflow is gated. No disabled dead-end buttons: a direct unlock CTA
// replaces "Appliquer" (the same /api/fix call would refuse with
// "payment_required" anyway, so there is nothing a Previsualiser/Appliquer
// click could do here).
function FixLocked({ shop }: { shop: string }) {
  return (
    <div className="mt-4 border-t border-line pt-4">
      <div className="rounded-xl border border-warn/40 bg-warn-soft/50 p-3">
        <p className="text-sm text-ink">
          Les corrections automatiques sont incluses dans la mise en
          conformité. Débloquez l&apos;accès pour appliquer ce correctif.
        </p>
        <div className="mt-3">
          <UnlockButton
            shop={shop}
            returnPath={`/report?shop=${encodeURIComponent(shop)}`}
            label="Débloquer les corrections"
            className="tech-label rounded-full bg-ink px-3 py-1.5 text-paper hover:bg-white disabled:opacity-60"
          />
        </div>
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
type RevertedResult = { kind: "reverted" };
type MultiPreviewResult = { kind: "multi-preview"; targetCount: number; foundCount: number };
type MultiAppliedResult = {
  kind: "multi-applied";
  appliedCount: number;
  skippedCount: number;
  skipped: { targetId: string; reason: string }[];
};
// A multi-product find/replace that wrote to some but not all targets (see
// app/api/fix/route.ts's handleMultiTarget status "partial") - distinct from
// MultiAppliedResult so the UI never claims full success for a partial run.
type MultiPartialResult = {
  kind: "multi-partial";
  appliedCount: number;
  targetCount: number;
  skipped: { targetId: string; reason: string }[];
};
// The three non-blocking outcomes /api/fix always answers with instead of a
// raw HTTP error (see app/api/fix/route.ts): never paid or access expired,
// a dead Shopify token, or any other failure (userErrors, resolveTarget
// error, unexpected exception). None of these are rendered as a blocking
// error - each gets its own banner with the right call to action. code is
// carried through so the client can tell "nothing_applied" (offer to relaunch
// the audit) apart from every other failure (offer a plain retry).
type PaymentRequiredResult = { kind: "payment-required"; billingUrl: string; message: string };
type ReauthRequiredResult = { kind: "reauth-required"; reauthUrl: string };
type FailedResult = { kind: "failed"; message: string; code?: string };
type FixResult =
  | PreviewResult
  | AppliedResult
  | DriftResult
  | RevertedResult
  | MultiPreviewResult
  | MultiAppliedResult
  | MultiPartialResult
  | PaymentRequiredResult
  | ReauthRequiredResult
  | FailedResult;

// resolveTarget's ResolveError.error values (lib/shopifyFix.ts) are machine
// slugs; the server also now attaches a matching "message" (see
// lib/shopifyFix.ts's resolveErrorMessage), but this table is the client-side
// safety net for any slug that ever arrives without one, so the fallback
// below never renders the raw code. Also doubles as the legacy error-shape
// table for /api/fix/revert, which still answers with {error, status} rather
// than the {status:"failed", code, message} contract /api/fix uses.
const FIX_ERROR_CODE_MESSAGE: Record<string, string> = {
  shopify_reauth_required:
    "La connexion à Shopify a expiré. Réinstallez l'app depuis le Shopify App Store pour la rétablir.",
  shopify_token_error: "La connexion à Shopify a échoué. Réessayez.",
  target_not_found: "Le produit ou l'élément visé n'a pas été trouvé dans la boutique.",
  invalid_field: "Ce champ n'est pas pris en charge pour ce correctif.",
  missing_target_id: "La cible du correctif est introuvable.",
  fix_type_not_applicable: "Ce correctif ne peut pas être appliqué automatiquement.",
  variant_ambiguous: "Plusieurs variantes correspondent - correction manuelle nécessaire.",
  missing_policy_type: "Le type de politique est manquant.",
  // /api/fix/revert still answers 403 {error:"acces_expire"} (not part of this
  // route's rewrite) - give it the same non-technical wording as the
  // payment-required banner instead of the generic fallback.
  acces_expire:
    "Votre accès a expiré. Rechargez la page pour débloquer de nouveau les corrections.",
};

// Never falls back to body.detail/body.error verbatim: a slug either has a
// human message from the server, is translated via the table above, or gets
// the generic sentence. Raw technical text can never reach this text node.
function fixErrorMessage(body: unknown): string {
  const errs = (body as { userErrors?: { message: string }[] } | null)?.userErrors;
  if (errs?.length) return errs.map((e) => e.message).join(" ");
  const b = body as { message?: string; error?: string; code?: string } | null;
  if (b?.message) return b.message;
  const slug = b?.code ?? b?.error;
  if (slug && FIX_ERROR_CODE_MESSAGE[slug]) return FIX_ERROR_CODE_MESSAGE[slug];
  return "Une erreur est survenue.";
}

function fixReasonMessage(reason: string): string {
  return FIX_ERROR_CODE_MESSAGE[reason] ?? reason;
}

// Translates the unconditional-200 /api/fix contract (status
// "payment_required"/"reauth_required"/"failed") plus any genuine HTTP-level
// failure into one shared outcome. Returns null for a success status
// (applied/preview/drift/multi), which the caller still interprets itself.
function sharedFixOutcome(
  res: Response,
  body: unknown,
): PaymentRequiredResult | ReauthRequiredResult | FailedResult | null {
  if (!res.ok) {
    return { kind: "failed", message: fixErrorMessage(body) };
  }
  const b = body as
    | {
        status?: string;
        billingUrl?: string;
        reauthUrl?: string;
        message?: string;
        code?: string;
      }
    | null;
  if (b?.status === "payment_required") {
    return {
      kind: "payment-required",
      billingUrl: b.billingUrl || "/api/shopify/billing/start",
      message: b.message || "Débloquez l'accès pour appliquer ce correctif.",
    };
  }
  if (b?.status === "reauth_required") {
    return b.reauthUrl
      ? { kind: "reauth-required", reauthUrl: b.reauthUrl }
      : { kind: "failed", message: FIX_ERROR_CODE_MESSAGE.shopify_reauth_required };
  }
  if (b?.status === "failed") {
    return { kind: "failed", message: b.message || fixErrorMessage(body), code: b.code };
  }
  return null;
}

// True for the two fixTypes whose value is HTML (Shopify's rich text editor
// output): a product's descriptionHtml, and any policy body (fixType "policy"
// or "partial" always write a full HTML body via shopPolicyUpdate). Every
// other field (title, seo.title/description, productType, vendor, tags,
// compareAtPrice) is plain text and must never be parsed as markup.
function isHtmlPatch(patch: FixPatch): boolean {
  if (patch.fixType === "policy" || patch.fixType === "partial") return true;
  return patch.fixType === "product_seo" && patch.field === "descriptionHtml";
}

// Renders a preview value: sanitized, rendered HTML for the two HTML fields
// above (so the merchant sees formatted text instead of raw "<p>" tags), a
// plain paragraph otherwise. Sanitization happens client-side only (dompurify
// is dynamically imported so it never runs during SSR, where there is no DOM
// for it to use).
function FieldPreview({ value, patch }: { value: string; patch: FixPatch }) {
  if (!isHtmlPatch(patch)) {
    return <p className="text-ink">{value || "(vide)"}</p>;
  }
  return <HtmlPreview html={value} />;
}

const ALLOWED_HTML_TAGS = [
  "p",
  "br",
  "strong",
  "em",
  "b",
  "i",
  "u",
  "ul",
  "ol",
  "li",
  "a",
  "h1",
  "h2",
  "h3",
  "h4",
  "span",
  "div",
  "blockquote",
];

function HtmlPreview({ html }: { html: string }) {
  const [clean, setClean] = useState<string | null>(null);

  useEffect(() => {
    if (!html.trim()) {
      setClean(null);
      return;
    }
    let cancelled = false;
    import("dompurify").then(({ default: DOMPurify }) => {
      if (cancelled) return;
      setClean(
        DOMPurify.sanitize(html, {
          ALLOWED_TAGS: ALLOWED_HTML_TAGS,
          ALLOWED_ATTR: ["href"],
        }),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [html]);

  if (!html.trim()) return <p className="text-ink">(vide)</p>;
  if (clean === null) return <p className="text-ink">{html}</p>;
  return (
    <div
      className="text-ink mt-1 space-y-1 [&_a]:underline [&_a]:text-brand [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5"
      dangerouslySetInnerHTML={{ __html: clean }}
    />
  );
}

function FixActions({
  shop,
  auditId,
  patch,
  onRetryAudit,
}: {
  shop: string;
  auditId: string;
  patch: FixPatch;
  onRetryAudit: () => void;
}) {
  const [busy, setBusy] = useState<null | "preview" | "apply" | "revert">(null);
  const [result, setResult] = useState<FixResult | null>(null);
  // Lets the "Réessayer" button in the "failed" banner re-run whichever
  // action (preview/apply/revert) produced it, instead of forcing the
  // merchant back to the start of the flow.
  const retryRef = useRef<() => void>(() => {});

  const preview = async () => {
    retryRef.current = preview;
    setBusy("preview");
    try {
      const res = await fetch("/api/fix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shop, patch, mode: "preview", auditId }),
      });
      const body = await res.json().catch(() => null);
      const shared = sharedFixOutcome(res, body);
      if (shared) {
        setResult(shared);
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
      setResult({ kind: "failed", message: "Le serveur est injoignable." });
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    retryRef.current = apply;
    setBusy("apply");
    try {
      const res = await fetch("/api/fix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shop, patch, mode: "apply", auditId }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.status === "applied" && body?.multi) {
        const skipped = (body.skipped ?? []) as { targetId: string; reason: string }[];
        setResult({
          kind: "multi-applied",
          appliedCount: body.appliedCount ?? 0,
          skippedCount: body.skippedCount ?? 0,
          skipped: skipped.map((s) => ({ ...s, reason: fixReasonMessage(s.reason) })),
        });
        return;
      }
      if (res.ok && body?.status === "partial" && body?.multi) {
        const skipped = (body.skipped ?? []) as { targetId: string; reason: string }[];
        const appliedCount = body.appliedCount ?? 0;
        setResult({
          kind: "multi-partial",
          appliedCount,
          targetCount: appliedCount + (body.skippedCount ?? skipped.length),
          skipped: skipped.map((s) => ({ ...s, reason: fixReasonMessage(s.reason) })),
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
      setResult(sharedFixOutcome(res, body) ?? { kind: "failed", message: fixErrorMessage(body) });
    } catch {
      setResult({ kind: "failed", message: "Le serveur est injoignable." });
    } finally {
      setBusy(null);
    }
  };

  const revert = async (fixId: string) => {
    retryRef.current = () => revert(fixId);
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
      setResult(sharedFixOutcome(res, body) ?? { kind: "failed", message: fixErrorMessage(body) });
    } catch {
      setResult({ kind: "failed", message: "Le serveur est injoignable." });
    } finally {
      setBusy(null);
    }
  };

  const applied = result?.kind === "applied" ? result : null;
  const finished =
    result?.kind === "reverted" ||
    result?.kind === "multi-applied" ||
    result?.kind === "multi-partial" ||
    result?.kind === "payment-required" ||
    result?.kind === "reauth-required";

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
              {busy === "preview" ? "Chargement..." : "Prévisualiser"}
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
        <div className="mt-3 text-sm space-y-3">
          <div className="text-muted">
            <span className="tech-label text-faint">Actuel</span>
            <FieldPreview value={result.currentLive || ""} patch={patch} />
          </div>
          <div className="text-muted">
            <span className="tech-label text-faint">Proposé</span>
            <FieldPreview value={result.newValue || ""} patch={patch} />
          </div>
          {result.drift && (
            <p className="text-warn font-medium">
              Modifié depuis l&apos;audit
            </p>
          )}
        </div>
      )}

      {result?.kind === "applied" && (
        <p className="mt-3 text-sm text-go font-medium">Appliqué</p>
      )}

      {result?.kind === "reverted" && (
        <p className="mt-3 text-sm text-muted">Correction annulée.</p>
      )}

      {result?.kind === "drift" && (
        <p className="mt-3 text-sm text-warn font-medium">
          Ce champ a été modifié depuis l&apos;audit - relancez un audit.
        </p>
      )}

      {result?.kind === "failed" && (
        <div className="mt-3 rounded-xl border border-warn/40 bg-warn-soft/50 p-3">
          <p className="text-sm text-ink">{result.message}</p>
          {/* "nothing_applied" means the patch found nothing to change in the
              live data - the fix itself is stale, so retrying it verbatim
              would fail again. Only a fresh audit (new field_snapshots) can
              produce a patch worth retrying. */}
          {result.code === "nothing_applied" ? (
            <button
              type="button"
              onClick={onRetryAudit}
              disabled={busy !== null}
              className="tech-label mt-3 rounded-full border border-line-strong px-3 py-1.5 text-ink hover:border-brand hover:text-brand disabled:opacity-50"
            >
              Relancer l&apos;audit
            </button>
          ) : (
            <button
              type="button"
              onClick={() => retryRef.current()}
              disabled={busy !== null}
              className="tech-label mt-3 rounded-full border border-line-strong px-3 py-1.5 text-ink hover:border-brand hover:text-brand disabled:opacity-50"
            >
              Réessayer
            </button>
          )}
        </div>
      )}

      {result?.kind === "payment-required" && (
        <div className="mt-3 rounded-xl border border-warn/40 bg-warn-soft/50 p-3">
          <p className="text-sm text-ink">{result.message}</p>
          <div className="mt-3">
            <UnlockButton
              shop={shop}
              billingUrl={result.billingUrl}
              returnPath={`/report?shop=${encodeURIComponent(shop)}`}
              label="Débloquer les corrections"
              className="tech-label rounded-full bg-ink px-3 py-1.5 text-paper hover:bg-white disabled:opacity-60"
            />
          </div>
        </div>
      )}

      {result?.kind === "reauth-required" && (
        <div className="mt-3 rounded-xl border border-warn/40 bg-warn-soft/50 p-3">
          <p className="text-sm text-ink">
            La connexion à Shopify a expiré. Réinstallez l&apos;app pour
            reconnecter cette boutique.
          </p>
          <a
            href={result.reauthUrl}
            className="tech-label mt-3 inline-block rounded-full bg-ink px-3 py-1.5 text-paper hover:bg-white"
          >
            Se reconnecter via le Shopify App Store
          </a>
        </div>
      )}

      {result?.kind === "multi-preview" && (
        <p className="mt-3 text-sm text-muted">
          Concerné {result.targetCount} produit{result.targetCount > 1 ? "s" : ""}, dont{" "}
          {result.foundCount} avec la phrase encore présente.
        </p>
      )}

      {result?.kind === "multi-applied" && (
        <p className="mt-3 text-sm text-go font-medium">
          {result.appliedCount} produit{result.appliedCount > 1 ? "s" : ""} corrigé
          {result.appliedCount > 1 ? "s" : ""}
        </p>
      )}

      {result?.kind === "multi-partial" && (
        <div className="mt-3 text-sm">
          <p className="text-warn font-medium">
            {result.appliedCount} produit{result.appliedCount > 1 ? "s" : ""} corrigé
            {result.appliedCount > 1 ? "s" : ""} sur {result.targetCount}
          </p>
          <details className="mt-2 text-muted">
            <summary className="tech-label text-faint cursor-pointer">
              {result.skipped.length} ignoré{result.skipped.length > 1 ? "s" : ""}
            </summary>
            <ul className="mt-2 space-y-1 list-disc pl-5">
              {result.skipped.map((s) => (
                <li key={s.targetId}>{s.reason}</li>
              ))}
            </ul>
          </details>
        </div>
      )}
    </div>
  );
}

export default function ReportClient({ appStoreUrl }: { appStoreUrl: string }) {
  return (
    <Suspense fallback={<LoadingShell />}>
      <ReportInner appStoreUrl={appStoreUrl} />
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
