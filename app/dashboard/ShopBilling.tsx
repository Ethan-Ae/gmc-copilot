"use client";

import { useCallback, useEffect, useState } from "react";

// Minimal shape of billing_state + derived access flags as returned by
// /api/shopify/billing/status. Kept local so this client component never
// imports server-only modules.
type Access = { full: boolean; expired: boolean };
type BillingStatus = { access: Access } | null;

type LoadState = "loading" | "loaded" | "load-error";

// Per-shop billing panel. Since the pricing pivot there is a single offer: the
// one-time 149 CHF "Mise en conformite" charge, which unlocks full access to
// the shop for 30 days. After that the access expires and the merchant can
// re-run a compliance. Starting a charge redirects to Shopify's confirmationUrl.
export default function ShopBilling({ shop }: { shop: string }) {
  const [state, setState] = useState<LoadState>("loading");
  const [status, setStatus] = useState<BillingStatus>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/shopify/billing/status?shop=${encodeURIComponent(shop)}`,
      );
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setState("load-error");
        return;
      }
      setStatus({
        access: (body?.access as Access) ?? { full: false, expired: false },
      });
      setState("loaded");
    } catch {
      setState("load-error");
    }
  }, [shop]);

  useEffect(() => {
    // Fetch-on-mount: load() only sets state after an await, so no synchronous
    // cascade.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function start() {
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch("/api/shopify/billing/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shop, type: "one_time" }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.confirmationUrl) {
        // Hand the merchant over to Shopify to accept the charge. Keep the busy
        // state until the navigation completes.
        window.location.href = body.confirmationUrl as string;
        return;
      }
      setActionError(
        body?.detail || body?.error || "La creation du paiement a echoue.",
      );
    } catch {
      setActionError("Le serveur est injoignable.");
    }
    setBusy(false);
  }

  if (state === "loading") {
    return (
      <div className="rounded-2xl border border-line bg-paper p-4">
        <p className="tech-label text-faint">Facturation</p>
        <p className="mt-2 text-sm text-muted">Chargement de l&apos;etat...</p>
      </div>
    );
  }

  if (state === "load-error") {
    return (
      <div className="rounded-2xl border border-line bg-paper p-4">
        <p className="tech-label text-faint">Facturation</p>
        <button
          type="button"
          onClick={() => {
            setState("loading");
            void load();
          }}
          className="mt-2 text-sm text-brand hover:underline"
        >
          Etat de facturation indisponible - reessayer
        </button>
      </div>
    );
  }

  const full = status?.access.full ?? false;
  const expired = status?.access.expired ?? false;

  return (
    <div className="rounded-2xl border border-line bg-paper p-4">
      <p className="tech-label text-faint">Facturation</p>

      {/* Full access active: single confirmation badge. */}
      {full && (
        <div className="mt-2 flex flex-wrap gap-2">
          <Badge>Acces complet actif - 30 jours</Badge>
        </div>
      )}

      {/* Access expired (one-time charge older than 30 days). */}
      {expired && (
        <div className="mt-3 rounded-xl border border-warn/40 bg-warn-soft/50 p-3">
          <p className="text-sm text-ink">
            Votre acces est expire. Relancez une mise en conformite pour
            re-auditer cette boutique.
          </p>
          <div className="mt-3">
            <Offer
              title="Relancer la mise en conformite"
              price="149 CHF - paiement unique via Shopify"
              action="Relancer"
              busy={busy}
              onClick={start}
            />
          </div>
        </div>
      )}

      {/* No active access: the single one-time offer. */}
      {!full && !expired && (
        <div className="mt-3">
          <Offer
            title="Debloquer la mise en conformite"
            price="149 CHF - acces complet 30 jours via Shopify"
            action="Debloquer"
            busy={busy}
            onClick={start}
          />
        </div>
      )}

      {actionError && <p className="mt-3 text-sm text-nogo">{actionError}</p>}
    </div>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="tech-label inline-flex items-center gap-2 rounded-full bg-go-soft px-2 py-1 text-go">
      <span className="inline-block h-2 w-2 rounded-full bg-go" aria-hidden="true" />
      {children}
    </span>
  );
}

function Offer({
  title,
  price,
  action,
  busy,
  onClick,
}: {
  title: string;
  price: string;
  action: string;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <p className="font-medium text-ink">{title}</p>
        <p className="text-sm text-muted">{price}</p>
      </div>
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="tech-label shrink-0 rounded-full bg-ink px-4 py-2 text-paper transition-colors hover:bg-white disabled:opacity-60"
      >
        {busy ? "Redirection..." : action}
      </button>
    </div>
  );
}
