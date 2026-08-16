import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { auth, currentUser } from "@clerk/nextjs/server";
import { getShopsForUser } from "../../lib/db";
import { PENDING_SHOP_COOKIE } from "../../lib/pendingShopClaim";
import { getAuditsForUser, type AuditRow } from "../../lib/audits";
import { getMerchantSelectionForUser } from "../../lib/googleStore";
import ConnectShopify from "./ConnectShopify";
import MerchantAccountPicker from "./MerchantAccountPicker";
import ShopBilling from "./ShopBilling";

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

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ google?: string; billing?: string }>;
}) {
  const { userId } = await auth();

  // A shop installed from the App Store before sign-up waits on a signed
  // cookie. Hand it to the claim route, which owns the write and clears the
  // cookie, then comes straight back here. No cookie means nothing changes.
  if (userId) {
    const pending = (await cookies()).get(PENDING_SHOP_COOKIE);
    if (pending) redirect("/api/shopify/claim");
  }

  const user = await currentUser();
  const email = user?.primaryEmailAddress?.emailAddress ?? "inconnu";

  const shops = userId ? await getShopsForUser(userId) : [];
  const audits: AuditRow[] = userId ? await getAuditsForUser(userId) : [];
  const merchant = userId ? await getMerchantSelectionForUser(userId) : null;
  const params = await searchParams;
  const googleNotice = params.google;
  const billingReturned = params.billing === "done";
  const noMerchantAccount =
    googleNotice === "no_merchant_account" ||
    (merchant !== null &&
      !merchant.needs_account_choice &&
      merchant.merchant_account_id === null);

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 p-6">
      <p className="tech-label text-muted">Connecté : {email}</p>
      <h1 className="mt-2 text-2xl font-semibold text-ink">Tableau de bord</h1>

      {billingReturned && (
        <div className="mt-4 rounded-lg border border-go/40 bg-go-soft/60 p-4">
          <p className="text-ink">
            Retour de Shopify pris en compte. L&apos;etat de facturation
            ci-dessous est a jour.
          </p>
        </div>
      )}

      <div className="mt-6 flex flex-col gap-4">
        <div>
          <p className="tech-label text-faint">Connecter une boutique Shopify</p>
          <div className="mt-2">
            <ConnectShopify />
          </div>
        </div>
        <div>
          <Link
            href="/api/google/auth"
            className="tech-label self-start rounded border border-line-strong px-4 py-2 text-ink hover:bg-slate-soft inline-block"
          >
            Connecter Google Merchant Center
          </Link>

          {merchant?.needs_account_choice && merchant.accounts.length > 0 && (
            <MerchantAccountPicker
              accounts={merchant.accounts}
              current={merchant.merchant_account_id}
            />
          )}

          {noMerchantAccount && (
            <div className="mt-2 rounded-lg border border-nogo/40 bg-nogo-soft/50 p-4">
              <p className="text-ink">
                Aucun compte Merchant Center n&apos;est associe a ce compte
                Google. Connecte un compte Google qui administre un compte
                Merchant Center, puis reessaie.
              </p>
            </div>
          )}

          {merchant?.merchant_account_id && !merchant.needs_account_choice && (
            <p className="mt-2 tech-label text-faint">
              Compte Merchant Center : {merchant.merchant_account_id}
            </p>
          )}
        </div>
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
              <li key={s.shop} className="px-4 py-3">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="font-medium text-ink">{s.shop}</p>
                    <p className="tech-label text-faint">
                      Mise à jour {formatDate(s.updated_at)}
                    </p>
                  </div>
                  <a
                    href={`/report?shop=${encodeURIComponent(s.shop.trim())}`}
                    className="tech-label rounded bg-brand px-3 py-1.5 text-surface hover:bg-brand-ink"
                  >
                    Auditer
                  </a>
                </div>
                <div className="mt-3">
                  <ShopBilling shop={s.shop.trim()} />
                </div>
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
