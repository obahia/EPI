import { cn } from "@/lib/utils";

/**
 * Selo's signature mark: a rosette stamp, the shape a Brazilian carimbo leaves on a
 * document. `broken` renders it fractured along one radius, used only on the 404 page.
 */
export function SealMark({ className, broken = false }: { className?: string; broken?: boolean }) {
  const notches = Array.from({ length: 16 }, (_, i) => (i * 360) / 16);
  return (
    <svg viewBox="0 0 120 120" className={cn("text-primary", className)} fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
        {notches.map((deg) => (
          <line
            key={deg}
            x1="60"
            y1="6"
            x2="60"
            y2="16"
            transform={`rotate(${deg} 60 60)`}
            opacity={broken && deg > 150 && deg < 210 ? 0.15 : 1}
          />
        ))}
      </g>
      <circle cx="60" cy="60" r="42" stroke="currentColor" strokeWidth="2.5" opacity={broken ? 0.5 : 1} />
      {broken ? (
        <path d="M60 18 L52 60 L64 78 L48 102" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" fill="none" />
      ) : (
        <circle cx="60" cy="60" r="30" stroke="currentColor" strokeWidth="2.5" />
      )}
      <text
        x="60"
        y="66"
        textAnchor="middle"
        fontFamily="var(--font-heading)"
        fontSize="22"
        fill="currentColor"
        opacity={broken ? 0.4 : 1}
      >
        S
      </text>
    </svg>
  );
}
