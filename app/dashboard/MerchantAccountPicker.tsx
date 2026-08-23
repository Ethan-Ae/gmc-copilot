"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Account = { id: string; name: string };

export default function MerchantAccountPicker({
  accounts,
  current,
}: {
  accounts: Account[];
  current: string | null;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState(current ?? accounts[0]?.id ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/google/select-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: selected }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setError(body?.error ?? "Echec de l'enregistrement.");
        return;
      }
      router.refresh();
    } catch {
      setError("Echec de l'enregistrement.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-2 rounded-2xl border border-warn/40 bg-warn-soft/50 p-4">
      <p className="text-ink">
        Plusieurs comptes Merchant Center sont accessibles avec ce compte
        Google. Choisis celui a auditer.
      </p>
      <div className="mt-3 flex flex-col gap-2">
        {accounts.map((a) => (
          <label
            key={a.id}
            className="flex items-center gap-3 rounded-xl border border-line bg-ink-soft px-3 py-2"
          >
            <input
              type="radio"
              name="merchant-account"
              value={a.id}
              checked={selected === a.id}
              onChange={() => setSelected(a.id)}
            />
            <span className="font-medium text-ink">{a.name}</span>
            <span className="tech-label text-faint">ID {a.id}</span>
          </label>
        ))}
      </div>
      {error && <p className="mt-2 text-sm text-nogo">{error}</p>}
      <button
        type="button"
        onClick={save}
        disabled={saving || !selected}
        className="tech-label mt-3 rounded-full bg-ink px-4 py-2 text-paper hover:bg-white disabled:opacity-60"
      >
        {saving ? "Enregistrement..." : "Utiliser ce compte"}
      </button>
    </div>
  );
}
