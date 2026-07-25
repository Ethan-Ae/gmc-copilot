import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Conditions - Feedcompliant",
  description:
    "Conditions d'utilisation de Feedcompliant : service fourni en l'etat, portee de l'audit, tarification et droit applicable.",
};

export default function TermsPage() {
  return (
    <main className="flex-1 flex flex-col">
      <section className="mx-auto w-full max-w-3xl px-5 pt-16 sm:pt-24 pb-16">
        <p className="tech-label text-brand mb-4">Conditions</p>
        <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight leading-tight">
          Conditions d&apos;utilisation
        </h1>
        <p className="mt-4 text-muted leading-relaxed">
          En utilisant Feedcompliant, tu acceptes les conditions ci-dessous.
        </p>

        <div className="mt-12 space-y-10">
          <Section title="Service fourni en l'etat">
            <p>
              Feedcompliant est fourni en l&apos;etat, sans garantie de
              disponibilite ni d&apos;absence d&apos;erreur.
            </p>
          </Section>

          <Section title="Portee de l'audit">
            <p>
              L&apos;audit est une aide a la mise en conformite. Il ne garantit
              pas la decision de Google Merchant Center, qui reste seul juge de
              la validation de ta boutique.
            </p>
          </Section>

          <Section title="Tarification">
            <p>
              Les tarifs applicables sont ceux affiches sur la page{" "}
              <Link
                href="/pricing"
                className="text-brand underline hover:text-brand-ink"
              >
                Tarifs
              </Link>
              .
            </p>
          </Section>

          <Section title="Droit applicable">
            <p>
              Ces conditions sont regies par le droit suisse.
            </p>
          </Section>
        </div>
      </section>
    </main>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      <div className="mt-3 text-muted leading-relaxed">{children}</div>
    </section>
  );
}
