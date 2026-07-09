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
  title: "GMC Copilot - Audit de conformite Google Merchant Center",
  description:
    "Inspecte ta boutique Shopify et obtiens un verdict go / no-go avant la review Google Merchant Center.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider appearance={{ cssLayerName: "clerk" }}>
      <html
        lang="fr"
        className={`${plexSans.variable} ${plexMono.variable} h-full antialiased`}
      >
        <body className="min-h-full flex flex-col">
          <header className="flex items-center justify-between border-b border-line px-6 py-3">
            <Link href="/" className="tech-label text-brand">
              GMC Copilot
            </Link>
            <div className="flex items-center gap-3">
              <Show when="signed-out">
                <SignInButton mode="modal">
                  <button className="tech-label text-muted hover:text-ink">
                    Connexion
                  </button>
                </SignInButton>
                <SignUpButton mode="modal">
                  <button className="tech-label rounded bg-brand px-3 py-1.5 text-surface hover:bg-brand-ink">
                    Inscription
                  </button>
                </SignUpButton>
              </Show>
              <Show when="signed-in">
                <UserButton />
              </Show>
            </div>
          </header>
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
