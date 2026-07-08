"use client";

import { useState } from "react";

export default function Home() {
  const [shop, setShop] = useState("");

  function connect() {
    const s = shop.trim().toLowerCase();
    if (!s) return;
    const domain = s.endsWith(".myshopify.com") ? s : `${s}.myshopify.com`;
    window.location.href = `/api/shopify/auth?shop=${encodeURIComponent(domain)}`;
  }

  return (
    <main
      style={{
        maxWidth: 480,
        margin: "80px auto",
        padding: 24,
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1 style={{ fontSize: 24, marginBottom: 8 }}>GMC Copilot</h1>
      <p style={{ color: "#555", marginBottom: 24 }}>
        Connecte ta boutique Shopify pour lancer l&apos;audit.
      </p>
      <input
        value={shop}
        onChange={(e) => setShop(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && connect()}
        placeholder="ta-boutique.myshopify.com"
        style={{
          width: "100%",
          padding: "10px 12px",
          fontSize: 16,
          marginBottom: 12,
          border: "1px solid #ccc",
          borderRadius: 8,
          boxSizing: "border-box",
        }}
      />
      <button
        onClick={connect}
        style={{
          width: "100%",
          padding: "10px 12px",
          fontSize: 16,
          background: "#111",
          color: "#fff",
          border: "none",
          borderRadius: 8,
          cursor: "pointer",
        }}
      >
        Connecter Shopify
      </button>
    </main>
  );
}
