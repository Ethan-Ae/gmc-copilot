"use client";

import { useState } from "react";

function normalizeShop(raw: string): string {
  let shop = raw.trim().toLowerCase();
  if (!shop) return "";
  // Strip protocol and any path the merchant may have pasted.
  shop = shop.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!shop.endsWith(".myshopify.com")) {
    shop = `${shop}.myshopify.com`;
  }
  return shop;
}

export default function ConnectShopify() {
  const [value, setValue] = useState("");

  function connect() {
    const shop = normalizeShop(value);
    if (!shop) return;
    window.location.href = `/api/shopify/auth?shop=${encodeURIComponent(shop)}`;
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        connect();
      }}
      className="flex flex-wrap items-center gap-2"
    >
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="ta-boutique.myshopify.com"
        className="min-w-64 rounded-xl border border-ink-line bg-ink-soft px-3.5 py-2.5 text-ink placeholder:text-faint focus:border-brand focus:outline-none"
      />
      <button
        type="submit"
        className="tech-label rounded-full bg-ink px-4 py-2 text-paper hover:bg-white"
      >
        Connecter
      </button>
    </form>
  );
}
