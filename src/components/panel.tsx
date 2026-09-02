import { cn } from "@/lib/utils";

/**
 * The soft surface every block in the mockup sits on: a large-radius card with no
 * border and no shadow, the cream ground showing through the gaps between panels.
 * Tables get `padded={false}` so their rows can run edge to edge inside it while the
 * panel's own header and footer keep the inset.
 */
export function Panel({
  className,
  children,
  tone = "card",
}: {
  className?: string;
  children: React.ReactNode;
  tone?: "card" | "secondary" | "primary" | "success" | "warning" | "destructive";
}) {
  const tones = {
    card: "bg-card",
    secondary: "bg-secondary",
    primary: "bg-primary text-primary-foreground",
    success: "bg-success-soft text-success",
    warning: "bg-warning-soft",
    destructive: "bg-destructive-soft",
  } as const;

  return <section className={cn("rounded-3xl p-5.5", tones[tone], className)}>{children}</section>;
}

/** Small uppercase label the mockup puts at the top of a panel instead of a heading. */
export function PanelKicker({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <p className={cn("text-[10.5px] font-bold tracking-[0.12em] uppercase opacity-70", className)}>{children}</p>
  );
}

/** Panel heading at the mockup's size -- used where a panel is titled rather than kickered. */
export function PanelTitle({ className, children }: { className?: string; children: React.ReactNode }) {
  return <h2 className={cn("font-heading text-lg font-extrabold tracking-tight", className)}>{children}</h2>;
}

/** The hairline-separated row of notes and pagination the mockup closes a table panel with. */
export function PanelFooter({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border/45 pt-4 text-[12.5px] text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
}
