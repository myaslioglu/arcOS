import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { THEME_BOOT_SCRIPT } from "@arcos/shell/core";
import { ThemeSync } from "@arcos/shell/theme";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

export const metadata: Metadata = {
  title: "4rc.OS",
  description: "A desktop for Arc: inspect tokens, mint, send in bulk, swap and bridge.",
  // Lets URL-based metadata fields (og:image, twitter:image, …) resolve to an absolute URL —
  // without it, a relative /t/<address>/opengraph-image path can't be embedded by link previews.
  ...(process.env.NEXT_PUBLIC_SITE_URL ? { metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL) } : {}),
};

/**
 * The server renders light. The boot script in <head> runs while the HTML is parsed, before the
 * first paint, and puts the visitor's theme on <html>; suppressHydrationWarning lets React keep it.
 * ThemeSync keeps it there afterwards on every route (see the shell's ui/theme.ts).
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning className={`${geist.variable} ${geistMono.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>
        <ThemeSync />
        {children}
      </body>
    </html>
  );
}
