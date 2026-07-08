"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";

// --- Audit contract types (see app/api/audit/route.ts) ---
type Overall = "go" | "warning" | "no-go";
type Severity = "high" | "medium" | "low";
type Area =
  | "product"
  | "seo"
  | "pricing"
  | "images"
  | "identity"
  | "needs-verification";

interface Issue {
  area: Area;
  product: string | null;
  severity: Severity;
  problem: string;
  fix: string;
}

interface Audit {
  overall: Overall;
  summary: string;
  issues: Issue[];
  checked: string[];
}

interface AuditResponse {
  shop: string;
  model: string;
  truncated: boolean;
  audit: Audit;
}

type State =
  | { status: "loading" }
  | { status: "ok"; data: AuditResponse }
  | { status: "not-connected" }
  | { status: "error"; message: string };

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

const AREA_LABEL: Record<Area, string> = {
  product: "Produit",
  seo: "SEO",
  pricing: "Prix",
  images: "Images",
  identity: "Identite",
  "needs-verification": "A verifier",
};

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

function Masthead({ shop }: { shop?: string }) {
  return (
    <header className="border-b border-line bg-ink text-paper">
      <div className="mx-auto w-full max-w-3xl px-5 py-3 flex items-center justify-between gap-4">
        <Link href="/" className="tech-label text-paper">
          GMC Copilot
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
  const shop = params.get("shop")?.trim().toLowerCase() ?? "";
  const [state, setState] = useState<State>(() =>
    shop
      ? { status: "loading" }
      : { status: "error", message: "Aucune boutique indiquee dans l'URL." },
  );

  // Fetch only sets state after an await, so it is safe to call from an effect.
  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/audit?shop=${encodeURIComponent(shop)}`);
      if (res.status === 404) {
        setState({ status: "not-connected" });
        return;
      }
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const message =
          (body && (body.detail || body.error)) ||
          `L'audit a echoue (code ${res.status}).`;
        setState({ status: "error", message });
        return;
      }
      setState({ status: "ok", data: body as AuditResponse });
    } catch {
      setState({
        status: "error",
        message:
          "Impossible de joindre le serveur d'audit. Verifie ta connexion et reessaie.",
      });
    }
  }, [shop]);

  const retry = useCallback(() => {
    setState({ status: "loading" });
    void load();
  }, [load]);

  useEffect(() => {
    // Fetch-on-mount: load() only calls setState after an await, so no
    // synchronous cascade despite what the static rule assumes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (shop) void load();
  }, [shop, load]);

  return (
    <main className="flex-1 flex flex-col">
      <Masthead shop={shop || undefined} />
      <div className="mx-auto w-full max-w-3xl px-5 py-10 flex-1">
        {state.status === "loading" && <LoadingView />}
        {state.status === "not-connected" && <NotConnectedView shop={shop} />}
        {state.status === "error" && (
          <ErrorView message={state.message} onRetry={retry} />
        )}
        {state.status === "ok" && (
          <ResultView data={state.data} onRetry={retry} />
        )}
      </div>
    </main>
  );
}

function LoadingView() {
  return (
    <section className="rise max-w-lg mx-auto text-center py-16">
      <p className="tech-label text-brand mb-4">Inspection en cours</p>
      <h1 className="text-2xl font-semibold tracking-tight">
        Analyse de ta boutique en cours...
      </h1>
      <p className="mt-3 text-muted leading-relaxed">
        On lit tes donnees produit et on les confronte aux regles Google
        Merchant Center. Cela prend generalement 10 a 30 secondes. Reste sur la
        page.
      </p>
      <div className="scan-track h-1 rounded-full mt-8" aria-hidden="true" />
      <p className="sr-only" role="status">
        Audit en cours, patiente.
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
          className="inline-flex mt-8 bg-brand hover:bg-brand-ink text-white font-medium rounded-md px-6 py-3 transition-colors"
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
      <p className="mt-4 border-l-2 border-l-nogo bg-nogo-soft/60 rounded-r-md px-4 py-3 font-mono text-sm text-ink">
        {message}
      </p>
      <p className="mt-4 text-muted leading-relaxed">
        Verifie le domaine de la boutique, puis relance. Si le probleme
        persiste, reessaie dans une minute - l&apos;analyse peut expirer si la
        boutique est lente a repondre.
      </p>
      <button
        onClick={onRetry}
        className="mt-8 bg-ink hover:bg-brand-ink text-white font-medium rounded-md px-6 py-3 transition-colors"
      >
        Reessayer
      </button>
    </section>
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

  return (
    <div className="rise space-y-8">
      {/* Verdict panel */}
      <section
        className={`bg-surface border border-line ${verdict.rail} border-l-4 rounded-lg p-6`}
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
            className="shrink-0 border border-line-strong hover:border-brand hover:text-brand text-ink font-medium rounded-md px-4 py-2 text-sm transition-colors"
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
        <h2 className="tech-label text-faint mb-4">
          Problemes detectes ({issues.length})
        </h2>
        {issues.length === 0 ? (
          <p className="bg-surface border border-line rounded-lg p-6 text-muted">
            Aucun probleme detecte sur les donnees inspectees.
          </p>
        ) : (
          <ul className="space-y-4">
            {issues.map((issue, i) => (
              <IssueCard key={i} issue={issue} />
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
                className="inline-flex items-center gap-2 bg-surface border border-line rounded-md px-3 py-1.5 font-mono text-xs text-muted"
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

function IssueCard({ issue }: { issue: Issue }) {
  const sev = SEVERITY[issue.severity] ?? SEVERITY.low;
  return (
    <li className="bg-surface border border-line rounded-lg p-5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`tech-label rounded px-2 py-1 ${sev.chip}`}>
          {sev.label}
        </span>
        <span className="tech-label rounded px-2 py-1 bg-slate-soft text-slate">
          {AREA_LABEL[issue.area] ?? issue.area}
        </span>
        {issue.product && (
          <span className="font-mono text-xs text-muted truncate">
            {issue.product}
          </span>
        )}
      </div>
      <p className="mt-3 text-ink leading-relaxed">{issue.problem}</p>
      <div className="mt-4 border-l-2 border-l-brand bg-brand-soft/70 rounded-r-md px-4 py-3">
        <p className="tech-label text-brand mb-1">Correctif</p>
        <p className="text-ink leading-relaxed">{issue.fix}</p>
      </div>
    </li>
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
        <LoadingView />
      </div>
    </main>
  );
}
