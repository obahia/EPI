import { cn } from "@/lib/utils";

/**
 * One counter tile in the dashboard grid, implemented from the mockup: the number
 * leads at display size with the label beneath it, on a soft tinted field with no
 * border. `tone="success"` is the one confirmed-count reading that is good news;
 * `hint` carries the secondary count the mockup hangs off "Contestadas".
 */
export function StatItem({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: number;
  hint?: string;
  tone?: "default" | "success";
}) {
  return (
    <div
      className={cn(
        "flex flex-col justify-center rounded-3xl px-6 py-5.5",
        tone === "success" ? "bg-success-soft text-success" : "bg-secondary",
      )}
    >
      <dd className="font-heading text-4xl font-extrabold tracking-tighter tabular-nums">{value}</dd>
      <dt className={cn("mt-1 text-[13px]", tone === "success" ? "opacity-80" : "text-muted-foreground")}>
        {label}
        {hint ? <span> · {hint}</span> : null}
      </dt>
    </div>
  );
}
