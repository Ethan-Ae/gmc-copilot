import Link from "next/link";
import { auth, currentUser } from "@clerk/nextjs/server";
import { getShopsForUser } from "../../lib/db";
import { getAuditsForUser, type AuditRow } from "../../lib/audits";

export const runtime = "nodejs";

const VERDICT: Record<string, { label: string; dot: string; text: string }> = {
  go: { label: "Go", dot: "bg-go", text: "text-go" },
  warning: { label: "A surveiller", dot: "bg-warn", text: "text-warn" },
  "no-go": { label: "No-go", dot: "bg-nogo", text: "text-nogo" },
};

function verdict(overall: string | null) {
  return (
    VERDICT[overall ?? ""] ?? {
      label: overall ?? "Inconnu",
      dot: "bg-faint",
      text: "text-muted",
    }
  );
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default async function DashboardPage() {
  const { userId } = await auth();
  const user = await currentUser();
  const email = user?.primaryEmailAddress?.emailAddress ?? "inconnu";

  const shops = userId ? await getShopsForUser(userId) : [];
  const audits: AuditRow[] = userId ? await getAuditsForUser(userId) : [];

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 p-6">
      <p className="tech-label text-muted">Connecté : {email}</p>
      <h1 className="mt-2 text-2xl font-semibold text-ink">Tableau de bord</h1>

      <div className="mt-6 flex flex-wrap gap-3">
        <Link
          href="/api/shopify/auth"
          className="tech-label rounded bg-brand px-4 py-2 text-surface hover:bg-brand-ink"
        >
          Connecter une boutique Shopify
        </Link>
        <Link
          href="/api/google/auth"
          className="tech-label rounded border border-line-strong px-4 py-2 text-ink hover:bg-slate-soft"
        >
          Connecter Google Merchant Center
        </Link>
      </div>

      <section className="mt-8">
        <h2 className="tech-label text-brand">Boutiques connectées</h2>
        {shops.length === 0 ? (
          <p className="mt-2 text-muted">
            Aucune boutique connectée pour l&apos;instant.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-line rounded-lg border border-line bg-surface">
            {shops.map((s) => (
              <li
                key={s.shop}
                className="flex items-center justify-between px-4 py-3"
              >
                <div>
                  <p className="font-medium text-ink">{s.shop}</p>
                  <p className="tech-label text-faint">
                    Mise à jour {formatDate(s.updated_at)}
                  </p>
                </div>
                <Link
                  href={`/report?shop=${encodeURIComponent(s.shop)}`}
                  className="tech-label rounded bg-brand px-3 py-1.5 text-surface hover:bg-brand-ink"
                >
                  Auditer
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-8">
        <h2 className="tech-label text-brand">Audits récents</h2>
        {audits.length === 0 ? (
          <p className="mt-2 text-muted">Aucun audit enregistré.</p>
        ) : (
          <ul className="mt-3 divide-y divide-line rounded-lg border border-line bg-surface">
            {audits.map((a) => {
              const v = verdict(a.overall);
              return (
                <li
                  key={a.id}
                  className="flex items-center justify-between px-4 py-3"
                >
                  <div>
                    <p className="font-medium text-ink">
                      {a.shop ?? "Boutique inconnue"}
                    </p>
                    <p className="tech-label text-faint">
                      {formatDate(a.created_at)}
                    </p>
                  </div>
                  <span className={`flex items-center gap-2 ${v.text}`}>
                    <span
                      className={`inline-block h-2.5 w-2.5 rounded-full ${v.dot}`}
                    />
                    <span className="tech-label">{v.label}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
