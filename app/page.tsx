"use client";

import Link from "next/link";
import { useState } from "react";

// --- Teaser contract (see app/api/teaser/route.ts) ---
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

interface TeaserIssue {
  area: Area;
  severity: Severity;
  problem: string;
}

interface TeaserResponse {
  domain: string;
  overall: Overall | null;
  issueCount: number;
  teaserIssues: TeaserIssue[];
  locked: boolean;
  message?: string;
}

type State =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; data: TeaserResponse }
  | { status: "locked"; message: string }
  | { status: "rate-limited" }
  | { status: "unreachable" };

// --- Presentation config (mirrors the report page) ---
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

const SEVERITY: Record<Severity, { label: string; chip: string; rail: string }> =
  {
    high: { label: "Critique", chip: "bg-nogo-soft text-nogo", rail: "border-l-nogo" },
    medium: { label: "Moyen", chip: "bg-warn-soft text-warn", rail: "border-l-warn" },
    low: { label: "Mineur", chip: "bg-slate-soft text-slate", rail: "border-l-slate" },
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

export default function Home() {
  const [url, setUrl] = useState("");
  const [state, setState] = useState<State>({ status: "idle" });

  async function run() {
    const value = url.trim();
    if (!value || state.status === "loading") return;
    setState({ status: "loading" });
    try {
      const res = await fetch("/api/teaser", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: value }),
      });
      if (res.status === 429) {
        setState({ status: "rate-limited" });
        return;
      }
      const body = (await res.json().catch(() => null)) as
        | (TeaserResponse & { error?: string })
        | null;
      if (!res.ok || !body) {
        setState({ status: "unreachable" });
        return;
      }
      if (body.locked) {
        setState({
          status: "locked",
          message:
            body.message ??
            "Ta boutique est protegee par mot de passe, on ne peut pas l'auditer publiquement.",
        });
        return;
      }
      setState({ status: "success", data: body });
    } catch {
      setState({ status: "unreachable" });
    }
  }

  return (
    <main className="flex-1 flex flex-col">
      <header className="border-b border-line bg-ink text-paper">
        <div className="mx-auto w-full max-w-3xl px-5 py-3 flex items-center justify-between">
          <span className="tech-label text-paper">GMC Copilot</span>
          <span className="tech-label text-faint">Inspection console</span>
        </div>
      </header>

      {/* Hero + teaser input */}
      <section className="mx-auto w-full max-w-3xl px-5 pt-16 sm:pt-24 pb-8">
        <p className="tech-label text-brand mb-4">
          Audit de conformite Merchant Center
        </p>
        <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight leading-tight max-w-2xl">
          Passe la conformite Google Merchant Center sans y passer des heures.
        </h1>
        <p className="mt-4 text-muted max-w-xl leading-relaxed">
          Entre l&apos;URL de ta boutique. On inspecte ta vitrine publique et on
          rend un verdict clair en 30 secondes, gratuitement et sans compte.
        </p>

        <div className="mt-10 max-w-xl">
          <label htmlFor="url" className="tech-label text-faint block mb-2">
            URL de ta boutique
          </label>
          <div className="flex flex-col sm:flex-row gap-3">
            <input
              id="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && run()}
              placeholder="ta-boutique.com"
              autoComplete="off"
              spellCheck={false}
              disabled={state.status === "loading"}
              className="flex-1 bg-surface border border-line-strong rounded-md px-4 py-3 font-mono text-sm text-ink placeholder:text-faint focus:border-brand disabled:opacity-60"
            />
            <button
              onClick={run}
              disabled={state.status === "loading"}
              className="shrink-0 bg-brand hover:bg-brand-ink text-white font-medium rounded-md px-6 py-3 transition-colors disabled:opacity-60"
            >
              {state.status === "loading"
                ? "Analyse..."
                : "Auditer gratuitement"}
            </button>
          </div>
          <p className="mt-3 text-xs text-faint">
            Aucune connexion requise. On lit seulement ce qui est deja public sur
            ta boutique.
          </p>
        </div>
      </section>

      {/* Result area */}
      {state.status !== "idle" && (
        <section className="mx-auto w-full max-w-3xl px-5 pb-8">
          {state.status === "loading" && <LoadingView />}
          {state.status === "unreachable" && (
            <NoticeView
              tone="nogo"
              eyebrow="Boutique injoignable"
              message="Impossible d'atteindre ta boutique, reessaie dans quelques minutes."
            />
          )}
          {state.status === "rate-limited" && (
            <NoticeView
              tone="warn"
              eyebrow="Trop de tentatives"
              message="Tu as lance beaucoup d'audits gratuits. Reessaie dans quelques minutes ou passe au rapport complet."
            />
          )}
          {state.status === "locked" && (
            <NoticeView
              tone="warn"
              eyebrow="Boutique verrouillee"
              message={state.message}
            />
          )}
          {state.status === "success" && <TeaserResult data={state.data} />}
        </section>
      )}

      {/* How it works */}
      <HowItWorks />
    </main>
  );
}

function LoadingView() {
  return (
    <div className="rise max-w-xl mx-auto text-center py-12">
      <p className="tech-label text-brand mb-4">Inspection en cours</p>
      <h2 className="text-xl font-semibold tracking-tight">
        Analyse de ta boutique en cours...
      </h2>
      <p className="mt-3 text-muted leading-relaxed">
        On lit ta vitrine publique et on la confronte aux regles Google Merchant
        Center. Cela prend generalement 10 a 30 secondes. Reste sur la page.
      </p>
      <div className="scan-track h-1 rounded-full mt-8" aria-hidden="true" />
      <p className="sr-only" role="status">
        Audit en cours, patiente.
      </p>
    </div>
  );
}

function NoticeView({
  tone,
  eyebrow,
  message,
}: {
  tone: "warn" | "nogo";
  eyebrow: string;
  message: string;
}) {
  const rail = tone === "nogo" ? "border-l-nogo" : "border-l-warn";
  const soft = tone === "nogo" ? "bg-nogo-soft/60" : "bg-warn-soft/60";
  const text = tone === "nogo" ? "text-nogo" : "text-warn";
  return (
    <div className="rise max-w-xl mx-auto py-6">
      <p className={`tech-label mb-3 ${text}`}>{eyebrow}</p>
      <p
        className={`border-l-2 ${rail} ${soft} rounded-r-md px-4 py-3 font-mono text-sm text-ink`}
      >
        {message}
      </p>
    </div>
  );
}

function TeaserResult({ data }: { data: TeaserResponse }) {
  const verdict = data.overall ? VERDICT[data.overall] : VERDICT.warning;
  const teased = data.teaserIssues ?? [];

  return (
    <div className="rise space-y-6">
      {/* Verdict panel */}
      <div
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
              <h2 className="text-2xl font-semibold tracking-tight">
                {verdict.label}
              </h2>
            </div>
          </div>
          <span className={`tech-label rounded px-2 py-1 ${verdict.chip}`}>
            {data.issueCount} probleme{data.issueCount > 1 ? "s" : ""} detecte
            {data.issueCount > 1 ? "s" : ""}
          </span>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-1 tech-label text-faint">
          <span>{data.domain}</span>
          <span aria-hidden="true">/</span>
          <span>Apercu gratuit</span>
        </div>
      </div>

      {/* Teased issues (max 2, no detailed fix) */}
      <ul className="space-y-4">
        {teased.map((issue, i) => {
          const sev = SEVERITY[issue.severity] ?? SEVERITY.low;
          return (
            <li
              key={i}
              className={`bg-surface border border-line ${sev.rail} border-l-4 rounded-lg p-5`}
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`tech-label rounded px-2 py-1 ${sev.chip}`}>
                  {sev.label}
                </span>
                <span className="tech-label rounded px-2 py-1 bg-slate-soft text-slate">
                  {AREA_LABEL[issue.area] ?? issue.area}
                </span>
              </div>
              <p className="mt-3 text-ink leading-relaxed">{issue.problem}</p>
            </li>
          );
        })}
      </ul>

      <Upsell issueCount={data.issueCount} />
    </div>
  );
}

// Adaptive upsell below the teasers. When several problems remain, a blurred
// locked block creates the urge to unlock. When the store is already in good
// shape, drop the anxiety-inducing blur for a reassuring block instead.
function Upsell({ issueCount }: { issueCount: number }) {
  if (issueCount >= 3) return <LockedPaywall remaining={issueCount - 2} />;
  return <PositiveUpsell issueCount={issueCount} />;
}

// Blurred, unreadable stack signalling there is more (the remaining issues and
// the detailed fixes), topped by the upgrade CTA.
function LockedPaywall({ remaining }: { remaining: number }) {
  return (
    <div className="relative overflow-hidden rounded-lg border border-line-strong">
      {/* Blurred, non-interactive teaser of the locked content */}
      <div
        className="space-y-4 p-5 blur-sm select-none pointer-events-none"
        aria-hidden="true"
      >
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="bg-surface border border-line border-l-4 border-l-slate rounded-lg p-5"
          >
            <div className="flex gap-2">
              <span className="tech-label rounded px-2 py-1 bg-nogo-soft text-nogo">
                Critique
              </span>
              <span className="tech-label rounded px-2 py-1 bg-slate-soft text-slate">
                Allegations
              </span>
            </div>
            <p className="mt-3 text-ink leading-relaxed">
              Probleme de conformite detecte sur ta boutique, avec le correctif
              exact a appliquer en un clic pour passer la review Google.
            </p>
            <div className="mt-4 border-l-2 border-l-brand bg-brand-soft/70 rounded-r-md px-4 py-3">
              <p className="tech-label text-brand mb-1">Correctif</p>
              <p className="text-ink leading-relaxed">
                Texte de correction pret a appliquer, masque dans l&apos;apercu
                gratuit.
              </p>
            </div>
          </div>
        ))}
      </div>

      {/* Overlay CTA */}
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center bg-paper/70 backdrop-blur-[2px] px-5">
        <p className="tech-label text-brand mb-2">Rapport complet verrouille</p>
        <h3 className="text-xl font-semibold tracking-tight max-w-md">
          {`Il reste ${remaining} probleme${
            remaining > 1 ? "s" : ""
          } et tous les correctifs detailles restent a decouvrir.`}
        </h3>
        <p className="mt-3 text-muted max-w-md leading-relaxed">
          Debloque le rapport complet, les correctifs prets a appliquer et le
          suivi de conformite.
        </p>
        <Link
          href="/pricing"
          className="inline-flex mt-6 bg-brand hover:bg-brand-ink text-white font-medium rounded-md px-6 py-3 transition-colors"
        >
          Voir le rapport complet et corriger &rarr; Tarifs
        </Link>
      </div>
    </div>
  );
}

// Reassuring block for a store already in good shape (<= 2 problems). No blur:
// the message is that a full audit confirms there is nothing blocking left.
function PositiveUpsell({ issueCount }: { issueCount: number }) {
  const body =
    issueCount === 0
      ? "Aucun probleme detecte sur les pages publiques. Un audit complet verifie aussi tes donnees produit et ton statut Merchant Center."
      : `On a repere ${issueCount} point${
          issueCount > 1 ? "s" : ""
        } mineur${
          issueCount > 1 ? "s" : ""
        }. Un audit complet confirme qu'aucun blocage ne reste avant ta review GMC.`;
  return (
    <div className="rounded-lg border border-go/40 bg-go-soft/50 p-6 text-center sm:text-left">
      <p className="tech-label text-go mb-2">Bonne nouvelle</p>
      <h3 className="text-xl font-semibold tracking-tight">
        Ta boutique est deja solide
      </h3>
      <p className="mt-3 text-muted max-w-xl leading-relaxed">{body}</p>
      <Link
        href="/pricing"
        className="inline-flex mt-6 bg-brand hover:bg-brand-ink text-white font-medium rounded-md px-6 py-3 transition-colors"
      >
        Obtenir la validation complete &rarr; Tarifs
      </Link>
    </div>
  );
}

function HowItWorks() {
  const steps = [
    {
      n: "01",
      title: "Audit",
      body: "On inspecte ta vitrine, tes policies et tes donnees produit pour trouver ce qui risque de bloquer la review Google.",
    },
    {
      n: "02",
      title: "Correctifs en 1 clic",
      body: "Chaque probleme vient avec sa correction exacte, prete a ecrire dans Shopify, sans jargon et sans invention.",
    },
    {
      n: "03",
      title: "Reste conforme",
      body: "On verifie que la donnee a bien propage avant de te donner un go, et on te previent si un risque reapparait.",
    },
  ];
  return (
    <section className="border-t border-line bg-surface mt-8">
      <div className="mx-auto w-full max-w-3xl px-5 py-16">
        <p className="tech-label text-brand mb-8">Comment ca marche</p>
        <div className="grid gap-6 sm:grid-cols-3">
          {steps.map((s) => (
            <div
              key={s.n}
              className="border border-line rounded-lg p-5 bg-paper"
            >
              <p className="tech-label text-faint mb-3">{s.n}</p>
              <h3 className="text-lg font-semibold tracking-tight">
                {s.title}
              </h3>
              <p className="mt-2 text-muted text-sm leading-relaxed">
                {s.body}
              </p>
            </div>
          ))}
        </div>

        <div className="mt-12 flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between border border-line-strong rounded-lg p-6 bg-paper">
          <div>
            <h3 className="text-lg font-semibold tracking-tight">
              Pret a savoir si ta boutique passe ?
            </h3>
            <p className="mt-1 text-muted text-sm">
              Lance un audit gratuit, sans compte, en 30 secondes.
            </p>
          </div>
          <Link
            href="/pricing"
            className="shrink-0 bg-ink hover:bg-brand-ink text-white font-medium rounded-md px-6 py-3 transition-colors"
          >
            Voir les tarifs
          </Link>
        </div>
      </div>
    </section>
  );
}
