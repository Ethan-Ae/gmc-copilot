import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import {
  ClerkProvider,
  Show,
  SignInButton,
  SignUpButton,
  UserButton,
} from "@clerk/nextjs";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Feedcompliant - Audit de conformite Google Merchant Center",
  description:
    "Feedcompliant inspecte ta boutique Shopify et rend un verdict go / no-go avant la review Google Merchant Center.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // Clerk widgets follow the dark system. Values mirror the tokens in
    // app/globals.css - keep both in sync when the palette moves.
    <ClerkProvider
      appearance={{
        cssLayerName: "clerk",
        variables: {
          colorBackground: "#111113",
          colorForeground: "#f5f5f7",
          colorMutedForeground: "#a1a1a6",
          colorPrimary: "#f5f5f7",
          colorPrimaryForeground: "#0a0a0a",
          colorInput: "#16161a",
          colorInputForeground: "#f5f5f7",
          colorNeutral: "#f5f5f7",
          colorBorder: "rgba(255, 255, 255, 0.1)",
          colorShadow: "rgba(0, 0, 0, 0.55)",
          colorModalBackdrop: "#000000",
          colorDanger: "#d17468",
          colorSuccess: "#5bb287",
          colorWarning: "#c99f55",
          borderRadius: "1rem",
        },
      }}
    >
      <html
        lang="fr"
        className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      >
        <body className="min-h-full flex flex-col">
          <header className="flex items-center justify-between border-b border-line-soft bg-paper px-6 py-4">
            <Link href="/" className="tech-label text-brand">
              Feedcompliant
            </Link>
            <div className="flex items-center gap-5">
              <Show when="signed-out">
                <SignInButton mode="modal" forceRedirectUrl="/dashboard">
                  <button className="tech-label text-muted hover:text-ink transition-colors">
                    Connexion
                  </button>
                </SignInButton>
                <SignUpButton mode="modal" forceRedirectUrl="/dashboard">
                  <button className="tech-label rounded-full bg-ink px-4 py-2 text-paper hover:bg-white transition-colors">
                    Inscription
                  </button>
                </SignUpButton>
              </Show>
              <Show when="signed-in">
                <Link
                  href="/dashboard"
                  className="tech-label text-muted hover:text-ink transition-colors"
                >
                  Tableau de bord
                </Link>
                <UserButton />
              </Show>
            </div>
          </header>
          {children}
          <footer className="border-t border-line-soft px-6 py-6">
            <div className="mx-auto flex w-full max-w-5xl flex-col items-center justify-between gap-3 sm:flex-row">
              <span className="tech-label text-faint">
                Feedcompliant
              </span>
              <nav className="flex items-center gap-5">
                <Link
                  href="/pricing"
                  className="tech-label text-muted hover:text-ink transition-colors"
                >
                  Tarifs
                </Link>
                <Link
                  href="/privacy"
                  className="tech-label text-muted hover:text-ink transition-colors"
                >
                  Confidentialite
                </Link>
                <Link
                  href="/terms"
                  className="tech-label text-muted hover:text-ink transition-colors"
                >
                  Conditions
                </Link>
              </nav>
            </div>
          </footer>
        </body>
      </html>
    </ClerkProvider>
  );
}
