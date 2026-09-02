import { cn } from "@/lib/utils";

/**
 * Selo's signature mark, implemented from the Selo Desktop design: a sunburst
 * disc (`repeating-conic-gradient`, 16 five-degree spokes) around a cream
 * inner circle with the "S" initial. `broken` (404 page only) dims the
 * sunburst and cracks the ring.
 */
export function SealMark({ className, broken = false }: { className?: string; broken?: boolean }) {
  return (
    <div className={cn("relative shrink-0", className)} style={{ containerType: "inline-size" }}>
      <div
        className="absolute inset-0 rounded-full"
        style={{
          background: "repeating-conic-gradient(from 0deg, var(--primary) 0deg 5deg, transparent 5deg 22.5deg)",
          opacity: broken ? 0.45 : 1,
        }}
        aria-hidden="true"
      />
      <div
        className="absolute rounded-full border-2 border-primary bg-background flex items-center justify-center"
        style={{ inset: "16%" }}
      >
        <span
          className="font-heading font-extrabold text-primary leading-none"
          style={{ fontSize: "32cqw", opacity: broken ? 0.5 : 1 }}
        >
          S
        </span>
      </div>
      {broken ? (
        <svg viewBox="0 0 100 100" className="absolute inset-0 text-primary" fill="none" aria-hidden="true">
          <path d="M50 3 L41 48 L59 64 L45 97" stroke="currentColor" strokeWidth="5" strokeLinecap="round" />
        </svg>
      ) : null}
    </div>
  );
}
