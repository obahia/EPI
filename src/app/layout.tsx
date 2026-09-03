import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Figtree } from "next/font/google";
import { cn } from "@/lib/utils";
import { Toaster } from "@/components/ui/sonner";
import { ServiceWorkerRegistrar } from "@/components/service-worker";
import { getLocale } from "@/i18n/get-locale";

/**
 * Figtree, weights 400/600/700/800, is both the heading and body face --
 * implemented from the Selo Desktop design, whose desktop screens all
 * override the "Organic" design system's default (Caprasimo) heading font to
 * Figtree Extrabold. Mono stays a system stack (matches the design's own
 * `ui-monospace, Menlo, monospace`), no separate monospace webfont needed.
 */
const figtree = Figtree({
  subsets: ["latin"],
  weight: ["400", "600", "700", "800"],
  variable: "--font-sans",
});

export const metadata: Metadata = {
  title: "Selo — Entrega Digital de EPI",
  description: "Plataforma de entrega digital de EPI com prova de recebimento selada.",
  applicationName: "Selo",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  // iOS does not read `display: standalone` from the manifest for home-screen launches --
  // it still needs these meta tags to open without Safari chrome (architecture §17).
  appleWebApp: {
    capable: true,
    title: "Selo",
    statusBarStyle: "default",
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: "#f5ead8",
  // `cover` lets the cream ground run under the notch and the home indicator; the layouts
  // pay for it with env(safe-area-inset-*) padding rather than leaving white bars.
  viewportFit: "cover",
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const locale = await getLocale();
  return (
    <html lang={locale === "en" ? "en" : "pt-BR"} className={cn("h-full antialiased", "font-sans", figtree.variable)}>
      <body className="flex min-h-full flex-col">
        {children}
        <Toaster />
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
