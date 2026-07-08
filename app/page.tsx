"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// Normalize any user input to a full myshopify domain.
function normalizeShop(raw: string): string {
  const s = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!s) return "";
  return s.endsWith(".myshopify.com") ? s : `${s}.myshopify.com`;
}

export default function Home() {
  const router = useRouter();
  const [shop, setShop] = useState("");

  function run() {
    const domain = normalizeShop(shop);
    if (!domain) return;
    router.push(`/report?shop=${encodeURIComponent(domain)}`);
  }

  return (
    <main className="flex-1 flex flex-col">
      <header className="border-b border-line bg-ink text-paper">
        <div className="mx-auto w-full max-w-3xl px-5 py-3 flex items-center justify-between">
          <span className="tech-label text-paper">GMC Copilot</span>
          <span className="tech-label text-faint">Inspection console</span>
        </div>
      </header>

      <div className="flex-1 flex items-center">
        <div className="mx-auto w-full max-w-3xl px-5 py-16 sm:py-24">
          <p className="tech-label text-brand mb-4">
            Audit de conformite Merchant Center
          </p>
          <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight leading-tight max-w-xl">
            Sais si ta boutique passe la review Google avant de la soumettre.
          </h1>
          <p className="mt-4 text-muted max-w-lg leading-relaxed">
            Entre le domaine de ta boutique Shopify. On inspecte tes donnees
            produit et on rend un verdict clair, avec les corrections a faire.
          </p>

          <div className="mt-10 max-w-lg">
            <label htmlFor="shop" className="tech-label text-faint block mb-2">
              Domaine de la boutique
            </label>
            <div className="flex flex-col sm:flex-row gap-3">
              <input
                id="shop"
                value={shop}
                onChange={(e) => setShop(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && run()}
                placeholder="ta-boutique.myshopify.com"
                autoComplete="off"
                spellCheck={false}
                className="flex-1 bg-surface border border-line-strong rounded-md px-4 py-3 font-mono text-sm text-ink placeholder:text-faint focus:border-brand"
              />
              <button
                onClick={run}
                className="shrink-0 bg-brand hover:bg-brand-ink text-white font-medium rounded-md px-6 py-3 transition-colors"
              >
                Lancer l&apos;audit
              </button>
            </div>
            <p className="mt-3 text-xs text-faint">
              L&apos;analyse prend 10 a 30 secondes. Boutique non connectee ? On
              te proposera de lier Shopify.
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
