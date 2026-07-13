import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Tarifs - GMC Copilot",
  description:
    "Choisis l'offre pour passer la conformite Google Merchant Center : audit express gratuit, mise en conformite one-shot ou offre agence.",
};

type Offer = {
  eyebrow: string;
  name: string;
  price: string;
  priceNote?: string;
  pitch: string;
  features: string[];
  cta: { label: string; href?: string };
  highlight?: boolean;
  footNote?: string;
};

const OFFERS: Offer[] = [
  {
    eyebrow: "Gratuit",
    name: "Audit express",
    price: "0 CHF",
    pitch: "Teste une boutique et recois un verdict clair, sans compte.",
    features: [
      "Audit public d'une boutique",
      "2 problemes reveles",
      "Verdict go / no-go",
      "Aucune connexion requise",
    ],
    cta: { label: "Auditer une boutique", href: "/" },
  },
  {
    eyebrow: "One-shot",
    name: "Mise en conformite",
    price: "200 CHF",
    priceNote: "paiement unique",
    pitch: "Passe une boutique en conformite, du diagnostic aux correctifs.",
    features: [
      "1 boutique, acces 30 jours",
      "Rapport complet, tous les problemes",
      "Correctifs en 1 clic",
      "Re-audits illimites pendant 30 jours",
    ],
    cta: { label: "Choisir cette offre" },
    highlight: true,
  },
  {
    eyebrow: "Mensuel",
    name: "Agence",
    price: "1400 CHF",
    priceNote: "par mois",
    pitch: "Pour les agences qui mettent en conformite plusieurs boutiques.",
    features: [
      "Boutiques illimitees",
      "Toutes les fonctions one-shot par boutique",
      "Re-audits illimites",
      "Rentable des 7 boutiques",
    ],
    cta: { label: "Choisir cette offre" },
  },
];

export default function PricingPage() {
  return (
    <main className="flex-1 flex flex-col">
      {/* Hero */}
      <section className="mx-auto w-full max-w-5xl px-5 pt-16 sm:pt-24 pb-8">
        <p className="tech-label text-brand mb-4">Tarifs</p>
        <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight leading-tight max-w-2xl">
          Choisis comment passer la conformite Merchant Center.
        </h1>
        <p className="mt-4 text-muted max-w-xl leading-relaxed">
          Commence par un audit gratuit, puis debloque le rapport complet et les
          correctifs quand tu es pret. Pas d&apos;engagement.
        </p>
      </section>

      {/* Offer cards */}
      <section className="mx-auto w-full max-w-5xl px-5 pb-8">
        <div className="grid gap-6 md:grid-cols-3 items-stretch">
          {OFFERS.map((o) => (
            <OfferCard key={o.name} offer={o} />
          ))}
        </div>

        <p className="mt-8 text-center text-sm text-muted max-w-xl mx-auto leading-relaxed">
          Le paiement arrive bientot. Pour l&apos;instant, aucun prelevement
          n&apos;est effectue : tu peux deja lancer un audit gratuit.
        </p>
      </section>
    </main>
  );
}

function OfferCard({ offer }: { offer: Offer }) {
  const shell = offer.highlight
    ? "border-brand border-2 bg-surface"
    : "border-line border bg-paper";
  return (
    <div
      className={`relative flex flex-col rounded-lg ${shell} p-6`}
    >
      {offer.highlight && (
        <span className="absolute -top-3 left-6 tech-label rounded bg-brand px-2 py-1 text-surface">
          Recommande
        </span>
      )}
      <p className="tech-label text-brand mb-2">{offer.eyebrow}</p>
      <h2 className="text-xl font-semibold tracking-tight">{offer.name}</h2>

      <div className="mt-4 flex items-baseline gap-2">
        <span className="text-3xl font-semibold tracking-tight">
          {offer.price}
        </span>
        {offer.priceNote && (
          <span className="tech-label text-faint">{offer.priceNote}</span>
        )}
      </div>

      <p className="mt-3 text-muted text-sm leading-relaxed">{offer.pitch}</p>

      <ul className="mt-6 space-y-3 flex-1">
        {offer.features.map((f) => (
          <li key={f} className="flex items-start gap-2.5 text-sm text-ink">
            <span
              className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-brand"
              aria-hidden="true"
            />
            <span className="leading-relaxed">{f}</span>
          </li>
        ))}
      </ul>

      <div className="mt-8">
        {offer.cta.href ? (
          <Link
            href={offer.cta.href}
            className="block text-center bg-brand hover:bg-brand-ink text-white font-medium rounded-md px-6 py-3 transition-colors"
          >
            {offer.cta.label}
          </Link>
        ) : (
          <button
            type="button"
            disabled
            className="w-full bg-ink/90 text-white font-medium rounded-md px-6 py-3 opacity-70 cursor-not-allowed"
          >
            {offer.cta.label}
          </button>
        )}
      </div>
    </div>
  );
}
