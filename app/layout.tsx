import type { Metadata } from "next";
import { IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import {
  ClerkProvider,
  Show,
  SignInButton,
  SignUpButton,
  UserButton,
} from "@clerk/nextjs";
import Link from "next/link";
import "./globals.css";

const plexSans = IBM_Plex_Sans({
  variable: "--font-plex-sans",
  weight: ["400", "500", "600", "700"],
  subsets: ["latin"],
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  weight: ["400", "500", "600"],
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
          colorBackground: "#0d1113",
          colorForeground: "#e8ebea",
          colorMutedForeground: "#9fa9a7",
          colorPrimary: "#e8ebea",
          colorPrimaryForeground: "#060809",
          colorInput: "#14191b",
          colorInputForeground: "#e8ebea",
          colorNeutral: "#e8ebea",
          colorBorder: "rgba(255, 255, 255, 0.1)",
          colorShadow: "rgba(0, 0, 0, 0.55)",
          colorModalBackdrop: "#000000",
          colorDanger: "#d17468",
          colorSuccess: "#5bb287",
          colorWarning: "#c99f55",
          borderRadius: "0.75rem",
        },
      }}
    >
      <html
        lang="fr"
        className={`${plexSans.variable} ${plexMono.variable} h-full antialiased`}
      >
        <body className="min-h-full flex flex-col">
          <header className="flex items-center justify-between border-b border-line px-6 py-3">
            <Link href="/" className="tech-label text-brand">
              Feedcompliant
            </Link>
            <div className="flex items-center gap-3">
              <Show when="signed-out">
                <SignInButton mode="modal" forceRedirectUrl="/dashboard">
                  <button className="tech-label text-muted hover:text-ink">
                    Connexion
                  </button>
                </SignInButton>
                <SignUpButton mode="modal" forceRedirectUrl="/dashboard">
                  <button className="tech-label rounded-full bg-ink px-3 py-1.5 text-paper hover:bg-white">
                    Inscription
                  </button>
                </SignUpButton>
              </Show>
              <Show when="signed-in">
                <Link
                  href="/dashboard"
                  className="tech-label text-muted hover:text-ink"
                >
                  Tableau de bord
                </Link>
                <UserButton />
              </Show>
            </div>
          </header>
          {children}
          <footer className="border-t border-line px-6 py-4">
            <div className="mx-auto flex w-full max-w-5xl flex-col items-center justify-between gap-2 sm:flex-row">
              <span className="tech-label text-faint">
                Feedcompliant
              </span>
              <nav className="flex items-center gap-4">
                <Link
                  href="/pricing"
                  className="tech-label text-muted hover:text-ink"
                >
                  Tarifs
                </Link>
                <Link
                  href="/privacy"
                  className="tech-label text-muted hover:text-ink"
                >
                  Confidentialite
                </Link>
                <Link
                  href="/terms"
                  className="tech-label text-muted hover:text-ink"
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
