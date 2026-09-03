import type { MetadataRoute } from "next";

/**
 * PWA manifest for the manager panel (docs/architecture.md §17). The point is a phone on
 * a construction site: the SST operator issues a delivery at the almoxarifado, shows the
 * QR, and checks who is still pending -- without hunting for a browser tab.
 *
 * `start_url` is /dashboard rather than /: an installed app should open on the work, and
 * /dashboard already redirects to the company panel (or to onboarding when there is no
 * company yet), so both states land somewhere sensible.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Selo — Entrega Digital de EPI",
    short_name: "Selo",
    description: "Prova de entrega de EPI, selada. Emita entregas, acompanhe confirmações e prove cada recebimento.",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    lang: "pt-BR",
    dir: "ltr",
    background_color: "#f5ead8",
    theme_color: "#f5ead8",
    categories: ["business", "productivity", "utilities"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // Android crops this one to its own shape, so it is drawn with the mark well inside
      // the 80% safe zone -- the "any" icons would lose their spokes to the crop.
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Entregas", short_name: "Entregas", url: "/deliveries" },
      { name: "Lotes", short_name: "Lotes", url: "/deliveries/batches" },
      { name: "Funcionários", short_name: "Equipe", url: "/employees" },
    ],
  };
}
