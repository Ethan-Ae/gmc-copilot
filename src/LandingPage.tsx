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

export default function LandingPage() {
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
      <Hero
        url={url}
        setUrl={setUrl}
        run={run}
        loading={state.status === "loading"}
      />

      {/* Result area */}
      {state.status !== "idle" && (
        <section className="mx-auto w-full max-w-3xl px-5 py-12 sm:py-16">
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
              message="Tu as lance beaucoup d'audits gratuits. Reessaie dans quelques heures ou passe au rapport complet."
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

      <WhyRefused />
      <AuditScope />
      <HowItWorks />
      <PricingStrip />
      <Faq />
      <FinalCta />
    </main>
  );
}

/* ---------------------------------------------------------------- Hero --- */

// Dark "inspection console" band: the storefront URL field is the only real
// call to action above the fold. Everything else on the page funnels back here.
function Hero({
  url,
  setUrl,
  run,
  loading,
}: {
  url: string;
  setUrl: (v: string) => void;
  run: () => void;
  loading: boolean;
}) {
  return (
    <section id="audit" className="relative overflow-hidden bg-paper text-ink">
      <div className="absolute inset-0 grid-field" aria-hidden="true" />
      <div className="absolute inset-0 brand-halo" aria-hidden="true" />

      <div className="relative mx-auto w-full max-w-3xl px-5 pt-16 pb-14 sm:pt-24 sm:pb-20">
        <p className="tech-label text-brand-lite mb-5">
          Audit de conformite Google Merchant Center
        </p>

        <h1 className="text-[2rem] sm:text-5xl font-semibold tracking-tight leading-[1.1] max-w-2xl">
          Google a refuse ton compte.
          <span className="block text-paper-dim">
            On te montre tout ce qui peut le declencher - et on le corrige.
          </span>
        </h1>

        <p className="mt-6 text-lg text-paper-dim max-w-xl leading-relaxed">
          Feedcompliant inspecte ta boutique Shopify avec la severite d&apos;un
          auditeur GMC : chaque promesse affichee est confrontee a tes policies, tes
          reglages et tes fiches produit. Tu recois la liste de ce qui risque de
          bloquer, puis les correctifs prets a appliquer.
        </p>

        {/* Audit form */}
        <div className="mt-10 max-w-xl">
          <label htmlFor="url" className="tech-label text-paper-faint block mb-2">
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
              disabled={loading}
              className="flex-1 bg-ink-soft border border-ink-line rounded-full px-4 py-3.5 font-mono text-sm text-ink placeholder:text-paper-faint focus:border-brand-lite focus:outline-none disabled:opacity-60"
            />
            <button
              onClick={run}
              disabled={loading}
              className="shrink-0 bg-ink hover:bg-white text-paper font-semibold rounded-full px-6 py-3.5 transition-colors disabled:opacity-60"
            >
              {loading ? "Analyse..." : "Auditer gratuitement"}
            </button>
          </div>
          <p className="mt-3 text-sm text-paper-faint leading-relaxed">
            Verdict en 30 secondes. Sans compte, sans carte. On lit uniquement
            ce qui est deja public sur ta boutique.
          </p>
        </div>

        {/* Factual signal row */}
        <dl className="mt-12 grid grid-cols-1 sm:grid-cols-3 gap-px bg-ink-line border border-ink-line rounded-3xl overflow-hidden">
          {[
            { k: "30 s", v: "Verdict go / no-go" },
            { k: "10 domaines", v: "Vitrine, policies, produits" },
            { k: "0 CHF", v: "Premier audit sans compte" },
          ].map((s) => (
            <div key={s.k} className="bg-surface px-5 py-4">
              <dt className="text-xl font-semibold tracking-tight text-ink">
                {s.k}
              </dt>
              <dd className="tech-label text-paper-faint mt-1">{s.v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

/* ------------------------------------------------------- Teaser states --- */

function LoadingView() {
  return (
    <div className="rise max-w-xl mx-auto text-center py-8">
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
    <div className="rise max-w-xl mx-auto">
      <p className={`tech-label mb-3 ${text}`}>{eyebrow}</p>
      <p
        className={`border-l-2 ${rail} ${soft} rounded-r-xl px-4 py-3 font-mono text-sm text-ink`}
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
        className={`bg-surface border border-line ${verdict.rail} border-l-4 rounded-3xl p-6`}
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
          <span className={`tech-label rounded-full px-2 py-1 ${verdict.chip}`}>
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
              className={`bg-surface border border-line ${sev.rail} border-l-4 rounded-3xl p-5`}
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`tech-label rounded-full px-2 py-1 ${sev.chip}`}>
                  {sev.label}
                </span>
                <span className="tech-label rounded-full px-2 py-1 bg-slate-soft text-slate">
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
    <div className="relative overflow-hidden rounded-3xl border border-line-strong">
      {/* Blurred, non-interactive teaser of the locked content */}
      <div
        className="space-y-4 p-5 blur-sm select-none pointer-events-none"
        aria-hidden="true"
      >
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="bg-surface border border-line border-l-4 border-l-slate rounded-3xl p-5"
          >
            <div className="flex gap-2">
              <span className="tech-label rounded-full px-2 py-1 bg-nogo-soft text-nogo">
                Critique
              </span>
              <span className="tech-label rounded-full px-2 py-1 bg-slate-soft text-slate">
                Allegations
              </span>
            </div>
            <p className="mt-3 text-ink leading-relaxed">
              Probleme de conformite detecte sur ta boutique, avec le correctif
              a appliquer en un clic avant de redemander la review Google.
            </p>
            <div className="mt-4 border-l-2 border-l-brand bg-brand-soft/70 rounded-r-xl px-4 py-3">
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
          className="inline-flex mt-6 bg-ink hover:bg-white text-paper font-medium rounded-full px-6 py-3 transition-colors"
        >
          Voir le rapport complet et corriger &rarr; Tarifs
        </Link>
      </div>
    </div>
  );
}

// Reassuring block for a store already in good shape (<= 2 problems). No blur:
// the message is that a full audit covers the surfaces the teaser cannot see.
function PositiveUpsell({ issueCount }: { issueCount: number }) {
  const body =
    issueCount === 0
      ? "Aucun probleme detecte sur les pages publiques. Un audit complet verifie aussi tes donnees produit et ton statut Merchant Center."
      : `On a repere ${issueCount} point${
          issueCount > 1 ? "s" : ""
        } mineur${
          issueCount > 1 ? "s" : ""
        }. Un audit complet couvre aussi tes donnees produit et ton statut Merchant Center avant ta review GMC.`;
  return (
    <div className="rounded-3xl border border-go/40 bg-go-soft/50 p-6 text-center sm:text-left">
      <p className="tech-label text-go mb-2">Bonne nouvelle</p>
      <h3 className="text-xl font-semibold tracking-tight">
        Ta boutique est deja solide
      </h3>
      <p className="mt-3 text-muted max-w-xl leading-relaxed">{body}</p>
      <Link
        href="/pricing"
        className="inline-flex mt-6 bg-ink hover:bg-white text-paper font-medium rounded-full px-6 py-3 transition-colors"
      >
        Obtenir l&apos;audit complet &rarr; Tarifs
      </Link>
    </div>
  );
}

/* ----------------------------------------------------- Editorial blocks --- */

// Small shared section heading: mono eyebrow + display title, matching the
// technical labelling used across the report pages.
function SectionHead({
  eyebrow,
  title,
  lead,
  tone = "brand",
}: {
  eyebrow: string;
  title: string;
  lead?: string;
  tone?: "brand" | "lite";
}) {
  return (
    <div className="max-w-2xl">
      <p
        className={`tech-label mb-4 ${
          tone === "lite" ? "text-brand-lite" : "text-brand"
        }`}
      >
        {eyebrow}
      </p>
      <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight leading-tight">
        {title}
      </h2>
      {lead && (
        <p
          className={`mt-4 leading-relaxed ${
            tone === "lite" ? "text-paper-dim" : "text-muted"
          }`}
        >
          {lead}
        </p>
      )}
    </div>
  );
}

const CAUSES = [
  {
    n: "01",
    title: "Une promesse que rien ne prouve",
    body: "Livraison gratuite annoncee sur la home, absente de la page livraison. Google constate l'ecart entre les deux pages, pas ton intention.",
  },
  {
    n: "02",
    title: "Un commercant non identifiable",
    body: "Pas d'adresse, pas de contact joignable, un nom qui change d'une page a l'autre : le compte n'est pas considere comme verifiable.",
  },
  {
    n: "03",
    title: "Des policies incompletes",
    body: "Retours, remboursements, conditions de vente : si une regle manque ou contredit la vitrine, la review bloque sans preciser laquelle.",
  },
];

function WhyRefused() {
  return (
    <section className="border-t border-line bg-paper">
      <div className="mx-auto w-full max-w-3xl px-5 py-16 sm:py-20">
        <SectionHead
          eyebrow="Le probleme"
          title="Le motif « misrepresentation » ne dit jamais ce qui cloche."
          lead="Google notifie un refus pour presentation trompeuse sans indiquer la page ni la phrase en cause. Dans la plupart des cas, il ne s'agit pas de fraude mais d'ecarts mecaniques entre ce que ta vitrine annonce et ce que tes policies et tes reglages disent vraiment. Le travail consiste a trouver chaque ecart, puis a le fermer."
        />

        <div className="mt-10 grid gap-4 sm:grid-cols-3">
          {CAUSES.map((c) => (
            <div
              key={c.n}
              className="border border-line rounded-3xl bg-surface p-5"
            >
              <p className="tech-label text-nogo mb-3">{c.n}</p>
              <h3 className="font-semibold tracking-tight leading-snug">
                {c.title}
              </h3>
              <p className="mt-2 text-sm text-muted leading-relaxed">
                {c.body}
              </p>
            </div>
          ))}
        </div>

        <div className="mt-10 border-l-2 border-l-brand bg-brand-soft/60 rounded-r-xl px-5 py-4">
          <p className="tech-label text-brand mb-1">Regle de travail</p>
          <p className="text-ink leading-relaxed">
            Rendre la boutique ennuyeusement verifiable. Toute claim publique
            doit etre vraie, prouvee ailleurs sur le site, et identique partout.
          </p>
        </div>
      </div>
    </section>
  );
}

const SCOPE: { area: string; body: string }[] = [
  {
    area: "Identite",
    body: "Nom commercial, adresse, moyen de contact reellement joignable.",
  },
  {
    area: "Politiques",
    body: "Livraison, retours, remboursements, CGV : presentes, completes, coherentes entre elles.",
  },
  {
    area: "Livraison",
    body: "Delais et frais annonces sur la vitrine contre ce que disent les policies et les reglages.",
  },
  {
    area: "Retours",
    body: "Fenetre de retour, conditions, qui paie le renvoi, et ou c'est ecrit.",
  },
  {
    area: "Allegations",
    body: "Garanties, avis, badges, urgence, promotions : chaque claim doit etre prouvable.",
  },
  {
    area: "Prix",
    body: "Prix affiche, prix barre, devise, coherence entre fiche produit et panier.",
  },
  {
    area: "Produit",
    body: "Titres, descriptions, variantes, disponibilite envoyees au feed.",
  },
  {
    area: "Images",
    body: "Images exploitables par Google et coherentes avec la fiche produit.",
  },
  {
    area: "SEO",
    body: "Titres et descriptions SEO alignes sur ce que voit reellement Merchant Center.",
  },
  {
    area: "Vitrine",
    body: "Textes du theme, banniere panier, navigation, FAQ : la ou se cachent les claims oubliees.",
  },
];

function AuditScope() {
  return (
    <section className="border-t border-line bg-surface">
      <div className="mx-auto w-full max-w-3xl px-5 py-16 sm:py-20">
        <SectionHead
          eyebrow="Perimetre"
          title="Dix domaines inspectes, un par un."
          lead="Le meme perimetre que celui d'un auditeur qui cherche une seule incoherence. Rien n'est declare conforme sans preuve visible sur ton site."
        />

        <ul className="mt-10 grid gap-px bg-line border border-line rounded-3xl overflow-hidden sm:grid-cols-2">
          {SCOPE.map((s, i) => (
            <li key={s.area} className="bg-surface p-5">
              <div className="flex items-baseline gap-3">
                <span className="tech-label text-faint">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <h3 className="font-semibold tracking-tight">{s.area}</h3>
              </div>
              <p className="mt-2 text-sm text-muted leading-relaxed">
                {s.body}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

const STEPS = [
  {
    n: "01",
    title: "Audit",
    body: "On crawle ta vitrine, tes policies et tes donnees produit, puis on confronte chaque claim a ce qui la prouve. Tu obtiens la liste complete de ce qui risque de bloquer la review.",
  },
  {
    n: "02",
    title: "Correctifs en 1 clic",
    body: "Chaque probleme arrive avec sa correction exacte, ecrite sans jargon et sans rien inventer. Tu relis, tu appliques sur Shopify, c'est ecrit pour toi.",
  },
  {
    n: "03",
    title: "Re-audit jusqu'au go",
    body: "Pendant 30 jours d'acces complet, re-audite autant que tu veux. On ne donne un go que lorsque la donnee corrigee est bien visible dans Merchant Center.",
  },
];

function HowItWorks() {
  return (
    <section className="border-t border-line bg-paper text-ink">
      <div className="mx-auto w-full max-w-3xl px-5 py-16 sm:py-20">
        <SectionHead
          eyebrow="Comment ca marche"
          tone="lite"
          title="Trois etapes, de la panne au feu vert."
        />

        <ol className="mt-10 space-y-px bg-ink-line border border-ink-line rounded-3xl overflow-hidden">
          {STEPS.map((s) => (
            <li key={s.n} className="bg-ink-soft p-6 sm:flex sm:gap-6">
              <p className="tech-label text-brand-lite sm:w-16 shrink-0 mb-3 sm:mb-0 sm:pt-1">
                {s.n}
              </p>
              <div>
                <h3 className="text-lg font-semibold tracking-tight">
                  {s.title}
                </h3>
                <p className="mt-2 text-paper-dim leading-relaxed">{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function PricingStrip() {
  return (
    <section className="border-t border-line bg-paper">
      <div className="mx-auto w-full max-w-3xl px-5 py-16 sm:py-20">
        <SectionHead
          eyebrow="Tarif"
          title="Un paiement unique. Pas d'abonnement."
          lead="La mise en conformite est un chantier, pas une routine mensuelle. Tu payes une fois, tu as 30 jours pour aller au bout, puis tu repars."
        />

        <div className="mt-10 grid gap-6 md:grid-cols-2 items-stretch">
          <div className="flex flex-col border border-line rounded-3xl bg-surface p-6">
            <p className="tech-label text-faint mb-2">Gratuit</p>
            <h3 className="text-xl font-semibold tracking-tight">
              Audit express
            </h3>
            <div className="mt-4 flex items-baseline gap-2">
              <span className="text-3xl font-semibold tracking-tight">
                0 CHF
              </span>
              <span className="tech-label text-faint">sans compte</span>
            </div>
            <ul className="mt-6 space-y-3 flex-1">
              {[
                "Audit de ta vitrine publique",
                "Verdict go / no-go",
                "2 problemes reveles",
                "Aucune connexion requise",
              ].map((f) => (
                <li
                  key={f}
                  className="flex items-start gap-2.5 text-sm text-ink"
                >
                  <span
                    className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-faint"
                    aria-hidden="true"
                  />
                  <span className="leading-relaxed">{f}</span>
                </li>
              ))}
            </ul>
            <a
              href="#audit"
              className="mt-8 block text-center border border-line-strong hover:border-ink text-ink font-medium rounded-full px-6 py-3 transition-colors"
            >
              Lancer l&apos;audit gratuit
            </a>
          </div>

          <div className="relative flex flex-col border border-brand/50 rounded-3xl bg-surface p-6">
            <span className="absolute -top-3 left-6 tech-label rounded-full bg-ink px-2 py-1 text-paper">
              Recommande
            </span>
            <p className="tech-label text-brand mb-2">One-shot</p>
            <h3 className="text-xl font-semibold tracking-tight">
              Mise en conformite
            </h3>
            <div className="mt-4 flex items-baseline gap-2">
              <span className="text-3xl font-semibold tracking-tight">
                149 CHF
              </span>
              <span className="tech-label text-faint">paiement unique</span>
            </div>
            <ul className="mt-6 space-y-3 flex-1">
              {[
                "1 boutique, acces complet 30 jours",
                "Rapport complet, tous les problemes",
                "Correctifs appliques sur Shopify en 1 clic",
                "Audits et re-audits illimites",
              ].map((f) => (
                <li
                  key={f}
                  className="flex items-start gap-2.5 text-sm text-ink"
                >
                  <span
                    className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-brand"
                    aria-hidden="true"
                  />
                  <span className="leading-relaxed">{f}</span>
                </li>
              ))}
            </ul>
            <Link
              href="/pricing"
              className="mt-8 block text-center bg-ink hover:bg-white text-paper font-medium rounded-full px-6 py-3 transition-colors"
            >
              Voir le detail de l&apos;offre
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

const FAQ = [
  {
    q: "Est-ce que ca garantit la validation Google ?",
    a: "Non, et personne ne peut la garantir : la decision reste celle de Google. Ce qu'on fait, c'est fermer tous les ecarts qu'on detecte avant que tu redemandes une review, et refuser de donner un go tant que la donnee corrigee n'est pas visible dans Merchant Center.",
  },
  {
    q: "Il faut savoir coder ?",
    a: "Non. Chaque correctif est redige pour toi et applique sur ta boutique Shopify en un clic. Tu relis le texte propose, tu valides, c'est ecrit.",
  },
  {
    q: "Quelles donnees vous lisez ?",
    a: "Pour l'audit gratuit, uniquement les pages deja publiques de ta boutique, comme le ferait n'importe quel visiteur. Pour l'acces complet, tes fiches produit Shopify et le statut de ton compte Merchant Center, via les connexions officielles que tu autorises.",
  },
  {
    q: "Mon compte est deja suspendu, c'est trop tard ?",
    a: "C'est le cas le plus courant, et non. L'audit sert justement a trouver ce qui a declenche le refus avant de redemander une review : redemander sans avoir corrige te fait surtout perdre du temps.",
  },
  {
    q: "Pourquoi un paiement unique plutot qu'un abonnement ?",
    a: "Parce que l'objectif est que tu n'aies plus besoin de nous. 149 CHF, 30 jours d'acces complet sur une boutique, audits et re-audits illimites jusqu'a ce que ce soit propre.",
  },
];

function Faq() {
  return (
    <section className="border-t border-line bg-surface">
      <div className="mx-auto w-full max-w-3xl px-5 py-16 sm:py-20">
        <SectionHead eyebrow="Questions" title="Ce qu'on nous demande." />

        <dl className="mt-10 divide-y divide-line border-t border-line">
          {FAQ.map((f) => (
            <div key={f.q} className="py-6 sm:grid sm:grid-cols-3 sm:gap-8">
              <dt className="font-semibold tracking-tight leading-snug sm:col-span-1">
                {f.q}
              </dt>
              <dd className="mt-2 sm:mt-0 sm:col-span-2 text-muted leading-relaxed">
                {f.a}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section className="border-t border-line bg-paper">
      <div className="mx-auto w-full max-w-3xl px-5 py-16 sm:py-20">
        <div className="rounded-3xl border border-line-strong bg-surface p-8 sm:p-10 text-center">
          <p className="tech-label text-brand mb-4">Commence ici</p>
          <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight leading-tight max-w-xl mx-auto">
            Savoir ce qui bloque prend 30 secondes.
          </h2>
          <p className="mt-4 text-muted max-w-lg mx-auto leading-relaxed">
            Entre l&apos;URL de ta boutique et recois le verdict. Pas de compte,
            pas de carte, pas d&apos;appel commercial.
          </p>
          <a
            href="#audit"
            className="inline-flex mt-8 bg-ink hover:bg-white text-paper font-medium rounded-full px-8 py-3.5 transition-colors"
          >
            Auditer ma boutique gratuitement
          </a>
        </div>
      </div>
    </section>
  );
}
