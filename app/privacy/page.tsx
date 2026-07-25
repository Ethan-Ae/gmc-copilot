import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Confidentialite - Feedcompliant",
  description:
    "Politique de confidentialite de Feedcompliant : donnees traitees, finalites, conservation et suppression.",
};

export default function PrivacyPage() {
  return (
    <main className="flex-1 flex flex-col">
      <section className="mx-auto w-full max-w-3xl px-5 pt-16 sm:pt-24 pb-16">
        <p className="tech-label text-brand mb-4">Confidentialite</p>
        <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight leading-tight">
          Politique de confidentialite
        </h1>
        <p className="mt-4 text-muted leading-relaxed">
          Cette page decrit les donnees que Feedcompliant traite, pourquoi, et
          comment elles sont conservees puis supprimees.
        </p>

        <div className="mt-12 space-y-10">
          <Section title="Editeur">
            <p>
              Le service Feedcompliant est edite par Feedcompliant. Pour toute
              question relative a ces donnees, contacte{" "}
              <a
                href="mailto:ethan.aeby08@outlook.com"
                className="text-brand underline hover:text-brand-ink"
              >
                ethan.aeby08@outlook.com
              </a>
              .
            </p>
          </Section>

          <Section title="Donnees traitees">
            <ul className="space-y-3">
              <Item>
                Compte utilisateur : ton adresse email, geree via notre
                prestataire d&apos;authentification Clerk.
              </Item>
              <Item>
                Tokens OAuth Shopify et Google : stockes chiffres cote serveur
                et jamais partages avec des tiers.
              </Item>
              <Item>
                Donnees de ta boutique : lues via les API Shopify et Google
                Merchant Center pour produire les audits (informations produit,
                policies, feed, reglages Merchant Center).
              </Item>
              <Item>
                Historique d&apos;audits : les rapports et resultats generes
                pour tes boutiques.
              </Item>
            </ul>
          </Section>

          <Section title="Finalite">
            <p>
              Ces donnees servent uniquement a auditer la conformite de ta
              boutique a Google Merchant Center et a appliquer les corrections
              que tu demandes. Nous ne vendons aucune donnee et ne faisons pas
              de publicite.
            </p>
          </Section>

          <Section title="Donnees Google et Limited Use">
            <p>
              Les donnees Google obtenues via les API Google respectent la{" "}
              <a
                href="https://developers.google.com/terms/api-services-user-data-policy"
                className="text-brand underline hover:text-brand-ink"
                target="_blank"
                rel="noopener noreferrer"
              >
                Google API Services User Data Policy
              </a>
              , y compris ses exigences Limited Use.
            </p>
          </Section>

          <Section title="Conservation et suppression">
            <ul className="space-y-3">
              <Item>
                Desinstallation de l&apos;app Shopify : les donnees de la
                boutique sont purgees, conformement au webhook shop/redact.
              </Item>
              <Item>
                Suppression de compte : sur demande adressee a{" "}
                <a
                  href="mailto:ethan.aeby08@outlook.com"
                  className="text-brand underline hover:text-brand-ink"
                >
                  ethan.aeby08@outlook.com
                </a>
                .
              </Item>
            </ul>
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

function Item({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <span
        className="mt-2 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-brand"
        aria-hidden="true"
      />
      <span>{children}</span>
    </li>
  );
}
