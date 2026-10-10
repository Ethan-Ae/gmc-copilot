import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Confidentialité - Feedcompliant",
  description:
    "Politique de confidentialité de Feedcompliant : données traitées, finalités, conservation et suppression.",
};

export default function PrivacyPage() {
  return (
    <main className="flex-1 flex flex-col">
      <section className="mx-auto w-full max-w-3xl px-5 pt-16 sm:pt-24 pb-16">
        <p className="tech-label text-brand mb-4">Confidentialité</p>
        <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight leading-tight">
          Politique de confidentialité
        </h1>
        <p className="mt-4 text-muted leading-relaxed">
          Cette page décrit les données que Feedcompliant traite, pourquoi, et
          comment elles sont conservées puis supprimées.
        </p>

        <div className="mt-12 space-y-10">
          <Section title="Éditeur">
            <p>
              Le service Feedcompliant est édité par Feedcompliant. Pour toute
              question relative à ces données, contacte{" "}
              <a
                href="mailto:ethan.aeby08@outlook.com"
                className="text-brand underline hover:text-brand-ink"
              >
                ethan.aeby08@outlook.com
              </a>
              .
            </p>
          </Section>

          <Section title="Données traitées">
            <ul className="space-y-3">
              <Item>
                Compte utilisateur : ton adresse email, gérée via notre
                prestataire d&apos;authentification Clerk.
              </Item>
              <Item>
                Tokens OAuth Shopify et Google : stockés chiffrés côté serveur
                et jamais partagés avec des tiers.
              </Item>
              <Item>
                Données de ta boutique : lues via les API Shopify et Google
                Merchant Center pour produire les audits (informations produit,
                policies, feed, réglages Merchant Center).
              </Item>
              <Item>
                Historique d&apos;audits : les rapports et résultats générés
                pour tes boutiques.
              </Item>
            </ul>
          </Section>

          <Section title="Finalité">
            <p>
              Ces données servent uniquement à auditer la conformité de ta
              boutique à Google Merchant Center et à appliquer les corrections
              que tu demandes. Nous ne vendons aucune donnée et ne faisons pas
              de publicité.
            </p>
          </Section>

          <Section title="Partage des données avec des tiers">
            <p>
              Feedcompliant ne vend ni ne loue aucune donnée. Les données Google
              (données Merchant Center accédées en lecture via l&apos;API
              Content) ne sont partagées avec aucun tiers à des fins commerciales
              ou publicitaires.
            </p>
            <p className="mt-3">
              Nous faisons appel à des sous-traitants techniques, strictement
              nécessaires au fonctionnement du service :
            </p>
            <ul className="mt-3 space-y-3">
              <Item>
                Vercel Inc. : hébergement de l&apos;application et exécution du
                code serveur.
              </Item>
              <Item>
                Neon Inc. : base de données Postgres, stockage des données du
                compte et des rapports.
              </Item>
              <Item>
                Anthropic PBC : traitement des données d&apos;audit par modèle de
                langage pour générer les rapports. Les données Merchant Center
                brutes ne sont transmises que dans la mesure nécessaire à
                l&apos;analyse.
              </Item>
              <Item>
                Clerk Inc. : authentification des comptes utilisateurs.
              </Item>
              <Item>
                Shopify Inc. : facturation et connexion boutique, dans le cadre
                de l&apos;app Shopify.
              </Item>
            </ul>
            <p className="mt-3">
              Aucune donnée Google n&apos;est transmise à d&apos;autres tiers que
              ces sous-traitants, et aucune donnée Google n&apos;est utilisée à
              des fins publicitaires. Notre usage des données Google respecte la
              Google API Services User Data Policy, y compris ses exigences
              Limited Use.
            </p>
          </Section>

          <Section title="Données Google et Limited Use">
            <p>
              Les données Google obtenues via les API Google respectent la{" "}
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

          <Section title="Protection des données">
            <ul className="space-y-3">
              <Item>
                Chiffrement en transit : tous les échanges passent par TLS/HTTPS,
                y compris avec les API Google et Shopify.
              </Item>
              <Item>
                Chiffrement au repos : notre base de données (Neon) chiffre les
                données stockées.
              </Item>
              <Item>
                Jetons d&apos;accès Google et Shopify stockés uniquement côté
                serveur, jamais exposés au navigateur, avec un accès restreint à
                l&apos;application.
              </Item>
              <Item>
                Moindre privilège : nous n&apos;accédons qu&apos;au strict
                nécessaire, et le scope Google utilisé est en lecture seule.
              </Item>
              <Item>
                Révocation et suppression : tu peux révoquer l&apos;accès Google
                à tout moment depuis ton compte Google. La suppression des
                données est détaillée dans la section Conservation et suppression
                ci-dessous.
              </Item>
            </ul>
          </Section>

          <Section title="Conservation et suppression">
            <ul className="space-y-3">
              <Item>
                Désinstallation de l&apos;app Shopify : les données de la
                boutique sont purgées, conformément au webhook shop/redact.
              </Item>
              <Item>
                Suppression de compte : sur demande adressée à{" "}
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
