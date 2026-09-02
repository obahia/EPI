import type { Metadata } from "next";
import "./globals.css";
import { Figtree } from "next/font/google";
import { cn } from "@/lib/utils";
import { Toaster } from "@/components/ui/sonner";
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
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const locale = await getLocale();
  return (
    <html lang={locale === "en" ? "en" : "pt-BR"} className={cn("h-full antialiased", "font-sans", figtree.variable)}>
      <body className="min-h-full flex flex-col">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
