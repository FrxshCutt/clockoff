import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import type { ReactNode } from "react";
import { Providers } from "@/components/providers";
import { SkipLink } from "@/components/shell/skip-link";
import { SITE } from "@/config/site";
import "./globals.css";

/**
 * Inter (variable) via next/font: downloaded once at build time and self-hosted (CSP `font-src 'self'`),
 * `display: swap`. The fallback is the platform UI stack (no metric-adjusted Arial face), so text renders
 * in the system font whenever Inter is unavailable:
 * - `next dev` without network: Next logs a warning and serves the fallback stack.
 * - `next build` without network: run it with
 *   `NEXT_FONT_GOOGLE_MOCKED_RESPONSES="$PWD/src/config/fonts/google-fonts-offline.cjs"` so the font
 *   loader skips Google Fonts and the app ships with the system stack only.
 */
const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
  adjustFontFallback: false,
  // next/font options must be literals (they are read at compile time). Keep in sync with `--font-sans`.
  fallback: [
    "ui-sans-serif",
    "system-ui",
    "-apple-system",
    "Segoe UI",
    "Roboto",
    "Helvetica Neue",
    "Arial",
    "sans-serif",
  ],
});

export const metadata: Metadata = {
  title: { default: SITE.name, template: `%s · ${SITE.name}` },
  description: SITE.description,
  applicationName: SITE.name,
  icons: { icon: [{ url: "/icon.svg", type: "image/svg+xml" }] },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#14151c" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-GB" suppressHydrationWarning className={inter.variable}>
      <body className="bg-background text-foreground min-h-svh font-sans antialiased">
        <SkipLink />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
