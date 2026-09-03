import Link from "next/link";
import {
  FileSpreadsheetIcon,
  FlagIcon,
  LayersIcon,
  QrCodeIcon,
  SmartphoneIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SealMark } from "@/components/seal-mark";
import { FaqItem } from "@/components/marketing/faq-item";
import { PricingSection } from "@/components/marketing/pricing-section";

/**
 * Public marketing landing page -- implemented from the "Selo Landing" mockup
 * (Claude Design project; provided as a rendered PDF after the DesignSync MCP
 * tool failed to authorize in this session).
 *
 * Hardcoded pt-BR, no i18n wrapper: same precedent as /verify/[code], /e/*
 * and /ficha/[employeeId] (docs/architecture.md, i18n scope) -- this is a
 * Brazilian-market page, not part of the authenticated dashboard.
 *
 * The mockup's hero stat row (142 mil / 86% / 40s) is kept per explicit user
 * direction (mockup fidelity) even though these are the mockup's own
 * placeholder numbers, not real usage data yet -- swap for real figures once
 * there's an actual customer base to report.
 *
 * Two of the mockup's "No canteiro" tags described features that do not
 * exist in this codebase (a badge camera-scan to open a delivery, and photo
 * capture attached to the confirmation) -- confirmed by reading src/app/e/*
 * end to end, there is no camera/photo code anywhere in the worker flow.
 * Reworded to the QR code that's real (the confirmation link IS rendered as
 * a scannable QR, see the delivery detail page's confirmation-link-panel)
 * and to the contest/dispute flow that's real (submitContest in
 * src/app/e/s/[id]/actions.ts). Same standard applied to the pricing
 * section's Obra-tier bullets below.
 */
const NUMBERED_PROBLEMS = [
  {
    n: "01",
    text: "A entrega é registrada num caderno ou numa planilha, e a assinatura fica numa pasta na obra.",
  },
  {
    n: "02",
    text: "Na fiscalização ou no processo trabalhista, provar quem recebeu o quê e quando leva dias.",
  },
  {
    n: "03",
    text: "Quando a ficha não aparece, a entrega vale zero — mesmo tendo acontecido.",
  },
];

const STEPS = [
  {
    n: "1",
    title: "Você emite",
    text: "Uma entrega ou um lote inteiro do turno. O catálogo já traz CA, fabricante e unidade.",
    tone: "bg-[color-mix(in_srgb,var(--primary)_10%,var(--card))]",
  },
  {
    n: "2",
    title: "Ele confirma",
    text: "Abre o link no celular, vê os itens da entrega e confirma com os três últimos dígitos do CPF.",
    tone: "bg-[color-mix(in_srgb,var(--primary)_10%,var(--card))]",
  },
  {
    n: "3",
    title: "O Selo prova",
    text: "Comprovante com código e hash, verificável por qualquer pessoa sem login, guardado por cinco anos.",
    tone: "bg-success-soft",
  },
];

const FIELD_TAGS = [
  { tag: "QR", tone: "bg-[color-mix(in_srgb,var(--primary)_16%,var(--card))] text-primary-deep", icon: QrCodeIcon, text: "O link de confirmação também sai como QR code, pronto pro funcionário escanear com a câmera do próprio celular." },
  { tag: "Recusa", tone: "bg-[color-mix(in_srgb,var(--primary)_16%,var(--card))] text-primary-deep", icon: FlagIcon, text: "O funcionário pode recusar o recebimento com motivo, sem travar a entrega pros outros itens." },
  { tag: "PWA", tone: "bg-[color-mix(in_srgb,var(--primary)_16%,var(--card))] text-primary-deep", icon: SmartphoneIcon, text: "Instala na tela inicial do celular do gestor, com alvos grandes e alto contraste no sol." },
  { tag: "Lotes", tone: "bg-success-soft text-success", icon: LayersIcon, text: "Um item para o turno inteiro: até 20 mil entregas emitidas de uma vez, cada uma com seu link." },
  { tag: "CSV", tone: "bg-success-soft text-success", icon: FileSpreadsheetIcon, text: "Importação da equipe com conferência de CPF e relatório das linhas com erro." },
];

const FAQS = [
  {
    q: "A confirmação no celular substitui a assinatura?",
    a: "A NR-6 exige registro do fornecimento, não uma assinatura em papel. O Selo guarda link, horário, verificação de identidade e hash — mais rastro do que uma ficha assinada.",
  },
  {
    q: "E quem não tem celular ou está sem sinal?",
    a: "O gestor confirma no aparelho dele, com o funcionário presente, e o evento fica registrado como confirmação assistida.",
  },
  {
    q: "Dá para importar o histórico que já temos?",
    a: "Sim, por CSV: funcionários, catálogo de EPIs e entregas passadas, marcadas como registro anterior ao Selo.",
  },
  {
    q: "Quem conta como funcionário ativo?",
    a: "Só quem recebeu alguma entrega no mês. Afastados e desligados não entram na cobrança.",
  },
];

const NAV_LINKS = [
  { href: "#como-funciona", label: "Como funciona" },
  { href: "#recursos", label: "Recursos" },
  { href: "#planos", label: "Planos" },
  { href: "#duvidas", label: "Dúvidas" },
];

export default function LandingPage() {
  return (
    <main className="flex flex-1 flex-col">
      <header className="border-b border-border/50">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-6 px-6 py-4">
          <Link href="/" className="flex items-center gap-2.5">
            <SealMark className="size-8" />
            <span className="font-heading text-lg font-extrabold tracking-tight">Selo</span>
          </Link>
          <nav className="hidden items-center gap-7 md:flex">
            {NAV_LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground"
              >
                {link.label}
              </a>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm">
              <Link href="/login">Entrar</Link>
            </Button>
            <Button asChild size="sm">
              <Link href="/login?mode=signup">Começar grátis</Link>
            </Button>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="mx-auto grid max-w-6xl gap-14 px-6 py-20 lg:grid-cols-2 lg:items-center lg:py-28">
          <div>
            <span className="inline-flex items-center rounded-full bg-success-soft px-3.5 py-1.5 text-xs font-bold text-success">
              NR-6 · ordem de serviço · guarda por 5 anos
            </span>
            <h1 className="mt-6 font-heading text-5xl font-extrabold tracking-tight text-balance sm:text-6xl">
              A entrega de EPI, provada em 40 segundos.
            </h1>
            <p className="mt-6 max-w-lg text-lg leading-relaxed text-muted-foreground">
              O trabalhador confirma pelo celular, sem instalar nada. Você fica com o comprovante selado, com
              código de verificação pública — não com uma ficha assinada que ninguém acha na hora da
              fiscalização.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Button asChild size="lg">
                <Link href="/login?mode=signup">Começar grátis</Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                {/* No demo-booking flow exists yet -- routes to the one real entry point. */}
                <Link href="/login">Ver uma demonstração</Link>
              </Button>
            </div>
            {/* Mockup fidelity: these are the mockup's own placeholder numbers (142 mil /
                86% / 40s), not a real usage claim -- swap for real figures once the
                product has actual customers/data behind them. */}
            <dl className="mt-10 flex flex-wrap gap-x-10 gap-y-4">
              <div>
                <dt className="sr-only">Entregas seladas</dt>
                <dd className="font-heading text-3xl font-extrabold tracking-tight">142 mil</dd>
                <p className="text-sm text-muted-foreground">entregas seladas</p>
              </div>
              <div>
                <dt className="sr-only">Confirmadas em 48 horas</dt>
                <dd className="font-heading text-3xl font-extrabold tracking-tight text-success">86%</dd>
                <p className="text-sm text-muted-foreground">confirmadas em 48 h</p>
              </div>
              <div>
                <dt className="sr-only">Mediana até confirmar</dt>
                <dd className="font-heading text-3xl font-extrabold tracking-tight">40s</dd>
                <p className="text-sm text-muted-foreground">mediana até confirmar</p>
              </div>
            </dl>
          </div>

          <div className="relative mx-auto w-full max-w-sm">
            <div
              className="pointer-events-none absolute top-1/2 left-1/2 size-[560px] -translate-x-1/2 -translate-y-1/2 rounded-full"
              style={{
                background:
                  "repeating-conic-gradient(from 0deg, color-mix(in srgb, var(--primary) 22%, transparent) 0deg 3deg, transparent 3deg 22.5deg)",
              }}
              aria-hidden="true"
            />
            <div className="relative rounded-[2.5rem] border-8 border-foreground bg-card p-5 shadow-xl">
              <div className="flex items-center justify-between text-[11px] font-semibold text-muted-foreground">
                <span>9:41</span>
                <span aria-hidden="true">■■■▲</span>
              </div>
              <p className="mt-4 text-[10px] font-bold tracking-[0.09em] text-muted-foreground uppercase">
                Construtora Verde Ltda
              </p>
              <h2 className="mt-1 font-heading text-lg font-extrabold tracking-tight">
                Você recebeu estes EPIs?
              </h2>
              <p className="text-xs text-muted-foreground">Rafael Souza · 02/09/2026</p>

              <div className="mt-4 flex flex-col gap-2.5">
                <div className="flex items-center justify-between rounded-2xl bg-secondary/70 px-3.5 py-3">
                  <div>
                    <p className="text-sm font-bold">Luva nitrílica</p>
                    <p className="text-xs text-muted-foreground">CA 38.771</p>
                  </div>
                  <span className="text-sm font-bold">2 PAR</span>
                </div>
                <div className="flex items-center justify-between rounded-2xl bg-secondary/70 px-3.5 py-3">
                  <div>
                    <p className="text-sm font-bold">Bota de segurança</p>
                    <p className="text-xs text-muted-foreground">CA 41.234</p>
                  </div>
                  <span className="text-sm font-bold">1 PAR</span>
                </div>
              </div>

              <Button className="mt-4 w-full" size="lg" tabIndex={-1} aria-hidden="true">
                Confirmar recebimento
              </Button>
              <Button className="mt-2 w-full" size="lg" variant="ghost" tabIndex={-1} aria-hidden="true">
                Algo está errado
              </Button>
            </div>

            {/* Below `sm`, the phone fills nearly the whole column, so there's no room to
                hang this chip off the left edge without covering the card's own text --
                it sits centered under the card there instead, and moves to the mockup's
                left-of-phone position from `sm` up where there's actual space for it. */}
            <div className="absolute bottom-[-1.5rem] left-1/2 -translate-x-1/2 rounded-2xl bg-foreground px-5 py-3 text-center shadow-lg sm:top-[75%] sm:bottom-auto sm:left-auto sm:-left-24 sm:translate-x-0 sm:-translate-y-1/2 md:-left-44">
              <p className="text-[10px] font-bold tracking-[0.09em] text-background/70 uppercase">
                Comprovante selado
              </p>
              <p className="font-mono text-sm font-bold text-background">47HH623Z9KBD</p>
            </div>
          </div>
        </div>
      </section>

      {/* O problema */}
      <section className="bg-secondary/60 py-20">
        <div className="mx-auto grid max-w-6xl gap-10 px-6 lg:grid-cols-2">
          <div>
            <p className="text-xs font-bold tracking-[0.09em] text-primary-deep uppercase">O problema</p>
            <h2 className="mt-2 font-heading text-3xl font-extrabold tracking-tight sm:text-4xl">
              A ficha existe. Achar a ficha é o problema.
            </h2>
          </div>
          <ol className="flex flex-col gap-6">
            {NUMBERED_PROBLEMS.map((item) => (
              <li key={item.n} className="flex gap-4">
                <span className="font-heading text-lg font-extrabold text-primary">{item.n}</span>
                <p className="text-muted-foreground">{item.text}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Como funciona */}
      <section id="como-funciona" className="py-20">
        <div className="mx-auto max-w-6xl px-6">
          <p className="text-xs font-bold tracking-[0.09em] text-primary-deep uppercase">Como funciona</p>
          <h2 className="mt-2 max-w-2xl font-heading text-3xl font-extrabold tracking-tight text-balance sm:text-4xl">
            Três passos, nenhum aplicativo para o trabalhador instalar.
          </h2>

          <div className="mt-10 grid gap-5 md:grid-cols-3">
            {STEPS.map((step) => (
              <div key={step.n} className={`rounded-3xl p-7 ${step.tone}`}>
                <span className="font-heading text-2xl font-extrabold text-primary">{step.n}</span>
                <h3 className="mt-3 font-heading text-lg font-extrabold tracking-tight">{step.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{step.text}</p>
              </div>
            ))}
          </div>

          <div id="recursos" className="mt-5 grid gap-5 lg:grid-cols-2">
            <div className="rounded-3xl bg-secondary/60 p-8">
              <p className="text-xs font-bold tracking-[0.09em] text-primary-deep uppercase">No canteiro</p>
              <h3 className="mt-2 font-heading text-2xl font-extrabold tracking-tight">
                Feito para quem está de luva.
              </h3>
              <ul className="mt-6 flex flex-col gap-4">
                {FIELD_TAGS.map((item) => (
                  <li key={item.tag} className="flex items-start gap-3">
                    <span
                      className={`flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${item.tone}`}
                    >
                      {item.tag}
                    </span>
                    <p className="text-sm text-muted-foreground">{item.text}</p>
                  </li>
                ))}
              </ul>
            </div>

            <div className="rounded-3xl bg-foreground p-8 text-background">
              <p className="text-xs font-bold tracking-[0.09em] text-background/60 uppercase">
                Verificação pública
              </p>
              <h3 className="mt-2 font-heading text-2xl font-extrabold tracking-tight">
                Qualquer pessoa confere, ninguém precisa de senha.
              </h3>
              <p className="mt-3 text-sm text-background/70">
                A página pública mostra código, empresa, data e o início do hash. Nome, CPF e itens não
                aparecem.
              </p>
              <div className="mt-6 flex items-center gap-4 rounded-2xl bg-background/10 p-4">
                <div
                  className="size-12 shrink-0 rounded-lg bg-background/20"
                  style={{
                    backgroundImage:
                      "repeating-conic-gradient(#fff 0% 25%, transparent 0% 50%)",
                    backgroundSize: "8px 8px",
                  }}
                  aria-hidden="true"
                />
                <div>
                  <p className="font-mono text-sm font-bold">47HH623Z9KBD</p>
                  <p className="text-xs text-background/60">Selado em 02/09/2026, 12:12:54</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Planos */}
      <section id="planos" className="bg-secondary/60 py-20">
        <div className="mx-auto max-w-6xl px-6">
          <PricingSection />
        </div>
      </section>

      {/* Dúvidas */}
      <section id="duvidas" className="py-20">
        <div className="mx-auto grid max-w-6xl gap-10 px-6 lg:grid-cols-[1fr_1.4fr]">
          <div>
            <p className="text-xs font-bold tracking-[0.09em] text-primary-deep uppercase">Dúvidas</p>
            <h2 className="mt-2 font-heading text-3xl font-extrabold tracking-tight text-balance sm:text-4xl">
              O que perguntam antes de assinar.
            </h2>
          </div>
          <div>
            {FAQS.map((faq) => (
              <FaqItem key={faq.q} question={faq.q} answer={faq.a} />
            ))}
          </div>
        </div>
      </section>

      {/* CTA final */}
      <section className="bg-foreground py-20 text-background">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-8 px-6">
          <h2 className="max-w-md font-heading text-3xl font-extrabold tracking-tight text-balance sm:text-4xl">
            Sele a próxima entrega ainda hoje.
          </h2>
          <div className="flex flex-wrap items-center gap-3">
            <Button asChild size="lg">
              <Link href="/login?mode=signup">Começar grátis</Link>
            </Button>
            <Button
              asChild
              size="lg"
              variant="outline"
              className="border-background/40 bg-transparent text-background hover:bg-background/10"
            >
              <Link href="/login">Agendar demonstração</Link>
            </Button>
          </div>
        </div>
      </section>

      <footer className="border-t border-background/10 bg-foreground py-10 text-background">
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-4 px-6 text-center sm:flex-row sm:justify-between sm:text-left">
          <div className="flex items-center gap-2.5">
            <SealMark className="size-7" />
            <div>
              <p className="font-heading text-sm font-extrabold tracking-tight">Selo</p>
              <p className="text-xs text-background/60">Prova de entrega de EPI</p>
            </div>
          </div>
          <nav className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm font-semibold text-background/70">
            <a href="#planos" className="hover:text-background">Planos</a>
            <a href="#duvidas" className="hover:text-background">Dúvidas</a>
            <Link href="/login" className="hover:text-background">Entrar</Link>
          </nav>
        </div>
      </footer>
    </main>
  );
}
