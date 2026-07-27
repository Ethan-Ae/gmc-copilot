"use client";

import { useCallback, useEffect, useState } from "react";

// Minimal shape of billing_state as returned by /api/shopify/billing/status.
// Kept local so this client component never imports server-only modules.
type BillingState = {
  one_time_status: string;
  subscription_status: string;
} | null;

type ChargeType = "one_time" | "subscription";

type LoadState = "loading" | "loaded" | "load-error";

// Per-shop billing panel: reads the current Shopify Billing state and lets the
// merchant unlock the one-time compliance charge or the monthly monitoring
// subscription. Starting a charge redirects to Shopify's confirmationUrl.
export default function ShopBilling({ shop }: { shop: string }) {
  const [state, setState] = useState<LoadState>("loading");
  const [billing, setBilling] = useState<BillingState>(null);
  const [busy, setBusy] = useState<ChargeType | null>(null);
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
      setBilling((body?.billing as BillingState) ?? null);
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

  async function start(type: ChargeType) {
    setBusy(type);
    setActionError(null);
    try {
      const res = await fetch("/api/shopify/billing/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shop, type }),
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
    setBusy(null);
  }

  if (state === "loading") {
    return (
      <div className="rounded-lg border border-line bg-paper p-4">
        <p className="tech-label text-faint">Facturation</p>
        <p className="mt-2 text-sm text-muted">Chargement de l&apos;etat...</p>
      </div>
    );
  }

  if (state === "load-error") {
    return (
      <div className="rounded-lg border border-line bg-paper p-4">
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

  const oneTimeActive = billing?.one_time_status === "active";
  const subActive = billing?.subscription_status === "active";

  return (
    <div className="rounded-lg border border-line bg-paper p-4">
      <p className="tech-label text-faint">Facturation</p>

      {(oneTimeActive || subActive) && (
        <div className="mt-2 flex flex-wrap gap-2">
          {oneTimeActive && <Badge>Mise en conformite active</Badge>}
          {subActive && <Badge>Surveillance active</Badge>}
        </div>
      )}

      {/* No active payment: full offer (one-time primary + subscription). */}
      {!oneTimeActive && !subActive && (
        <div className="mt-3 flex flex-col gap-3">
          <Offer
            title="Debloquer la mise en conformite"
            price="149 CHF - paiement unique via Shopify"
            action="Debloquer"
            variant="primary"
            busy={busy === "one_time"}
            disabled={busy !== null}
            onClick={() => start("one_time")}
          />
          <div className="border-t border-line pt-3">
            <Offer
              title="Surveillance continue"
              price="29 CHF/mois - via Shopify"
              action="Activer"
              variant="secondary"
              busy={busy === "subscription"}
              disabled={busy !== null}
              onClick={() => start("subscription")}
            />
          </div>
        </div>
      )}

      {/* One-time paid but no monitoring yet: offer the subscription. */}
      {oneTimeActive && !subActive && (
        <div className="mt-3 border-t border-line pt-3">
          <Offer
            title="Surveillance continue"
            price="29 CHF/mois - via Shopify"
            action="Activer"
            variant="secondary"
            busy={busy === "subscription"}
            disabled={busy !== null}
            onClick={() => start("subscription")}
          />
        </div>
      )}

      {actionError && <p className="mt-3 text-sm text-nogo">{actionError}</p>}
    </div>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="tech-label inline-flex items-center gap-2 rounded bg-go-soft px-2 py-1 text-go">
      <span className="inline-block h-2 w-2 rounded-full bg-go" aria-hidden="true" />
      {children}
    </span>
  );
}

function Offer({
  title,
  price,
  action,
  variant,
  busy,
  disabled,
  onClick,
}: {
  title: string;
  price: string;
  action: string;
  variant: "primary" | "secondary";
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const cls =
    variant === "primary"
      ? "bg-brand text-surface hover:bg-brand-ink"
      : "border border-line-strong text-ink hover:bg-slate-soft";
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <p className="font-medium text-ink">{title}</p>
        <p className="text-sm text-muted">{price}</p>
      </div>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={`tech-label shrink-0 rounded px-4 py-2 transition-colors disabled:opacity-60 ${cls}`}
      >
        {busy ? "Redirection..." : action}
      </button>
    </div>
  );
}
