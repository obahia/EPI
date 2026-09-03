"use client";

import { useState } from "react";
import Link from "next/link";
import { CheckIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Plan = {
  key: string;
  tier: string;
  price: number;
  priceNote: string;
  featured?: boolean;
  contactOnly?: boolean;
  features: string[];
  ctaLabel: string;
  ctaHref: string;
};

// Provisional marketing prices -- there is no billing system behind these yet (no PLANS
// constant, no Stripe/payment integration in this codebase). Anual = 10 months' worth
// spread over 12, matching the "2 meses grátis" badge; this is the only place that math
// happens, so it can't drift from what the badge promises.
const PLANS: Plan[] = [
  {
    key: "canteiro",
    tier: "Canteiro",
    price: 4.9,
    priceNote: "Mínimo de 20 funcionários",
    features: [
      "1 empresa · 1 canteiro",
      "Entregas e lotes ilimitados",
      "Catálogo de EPIs e importação CSV",
      "Comprovante com verificação pública",
      "Suporte por e-mail",
    ],
    ctaLabel: "Começar grátis",
    ctaHref: "/login?mode=signup",
  },
  {
    key: "obra",
    tier: "Obra",
    price: 3.9,
    priceNote: "A partir de 100 funcionários",
    featured: true,
    features: [
      "Tudo do Canteiro, e ainda:",
      "Várias empresas na mesma organização",
      "Ficha de controle de EPI pronta pra imprimir, por funcionário",
      "Painel de pendências e reenvio em massa",
      "Linha do tempo de auditoria completa por entrega",
      "Suporte no WhatsApp em horário comercial",
    ],
    ctaLabel: "Falar com vendas",
    ctaHref: "/login",
  },
  {
    key: "construtora",
    tier: "Construtora",
    price: 0,
    priceNote: "Acima de 1.000 funcionários",
    contactOnly: true,
    features: [
      "Tudo da Obra, e ainda:",
      "SSO e perfis por obra",
      "API e integração com ERP",
      "Retenção estendida e trilha de auditoria",
      "Gerente de conta e SLA em contrato",
    ],
    ctaLabel: "Pedir proposta",
    ctaHref: "/login",
  },
];

function formatPrice(value: number) {
  return value.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function PricingSection() {
  const [annual, setAnnual] = useState(false);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-6">
        <div>
          <p className="text-xs font-bold tracking-[0.09em] text-primary-deep uppercase">Planos</p>
          <h2 className="mt-2 font-heading text-3xl font-extrabold tracking-tight sm:text-4xl">
            Por funcionário ativo, por mês.
          </h2>
          <p className="mt-2 max-w-md text-muted-foreground">
            Sem taxa de implantação. Cancele quando quiser — os comprovantes continuam acessíveis.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1 rounded-full bg-secondary p-1" role="group" aria-label="Ciclo de cobrança">
          <button
            type="button"
            onClick={() => setAnnual(false)}
            aria-pressed={!annual}
            className={cn(
              "rounded-full px-4 py-1.5 font-heading text-sm font-extrabold transition-colors",
              !annual ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
            )}
          >
            Mensal
          </button>
          <button
            type="button"
            onClick={() => setAnnual(true)}
            aria-pressed={annual}
            className={cn(
              "rounded-full px-4 py-1.5 font-heading text-sm font-extrabold transition-colors",
              annual ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
            )}
          >
            Anual · 2 meses grátis
          </button>
        </div>
      </div>

      <div className="mt-10 grid gap-5 lg:grid-cols-3">
        {PLANS.map((plan) => (
          <div
            key={plan.key}
            className={cn(
              "flex flex-col rounded-3xl p-8",
              plan.featured ? "bg-primary text-primary-foreground" : "bg-card"
            )}
          >
            <div className="flex items-center justify-between">
              <p
                className={cn(
                  "text-xs font-bold tracking-[0.09em] uppercase",
                  plan.featured ? "text-primary-foreground/80" : "text-muted-foreground"
                )}
              >
                {plan.tier}
              </p>
              {plan.featured ? (
                <span className="rounded-full bg-background px-3 py-1 text-xs font-bold text-foreground">
                  Mais escolhido
                </span>
              ) : null}
            </div>

            <div className="mt-4">
              {plan.contactOnly ? (
                <span className="font-heading text-4xl font-extrabold tracking-tight">Sob consulta</span>
              ) : (
                <span className="font-heading text-4xl font-extrabold tracking-tight">
                  R$ {formatPrice(annual ? plan.price * (10 / 12) : plan.price)}
                  <span
                    className={cn(
                      "ml-1 text-sm font-semibold",
                      plan.featured ? "text-primary-foreground/80" : "text-muted-foreground"
                    )}
                  >
                    /func./mês
                  </span>
                </span>
              )}
              <p
                className={cn(
                  "mt-1 text-sm",
                  plan.featured ? "text-primary-foreground/80" : "text-muted-foreground"
                )}
              >
                {plan.priceNote}
              </p>
            </div>

            <ul className="mt-6 flex flex-1 flex-col gap-3">
              {plan.features.map((feature) => (
                <li key={feature} className="flex items-start gap-2 text-sm">
                  <CheckIcon
                    className={cn("mt-0.5 size-4 shrink-0", plan.featured ? "text-primary-foreground" : "text-success")}
                    aria-hidden="true"
                  />
                  <span className={plan.featured ? "text-primary-foreground" : "text-foreground"}>{feature}</span>
                </li>
              ))}
            </ul>

            {/* Canteiro is the only plan with a real self-serve path (sign-up); Obra/Construtora
                have no sales-contact or proposal flow yet, so their CTAs still just route to
                sign-in until that ships. */}
            <Button
              asChild
              size="lg"
              variant={plan.featured ? "secondary" : "outline"}
              className={cn(
                "mt-8 w-full",
                plan.featured && "bg-background text-foreground hover:bg-background/90"
              )}
            >
              <Link href={plan.ctaHref}>{plan.ctaLabel}</Link>
            </Button>
          </div>
        ))}
      </div>

      <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-muted-foreground">
        <span>Teste 14 dias sem cartão</span>
        <span className="hidden sm:inline">·</span>
        <span>Dados no Brasil, conforme a LGPD</span>
        <span className="hidden sm:inline">·</span>
        <span>Comprovantes guardados por 5 anos</span>
      </div>
    </div>
  );
}
