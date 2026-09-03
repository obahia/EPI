"use client";

import { useRef, useState } from "react";
import { EraserIcon, PenLineIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Canvas-based signature capture for the worker confirmation flow. Every stroke's pointerup
 * exports the canvas as a PNG data URL into a hidden `name="signature"` input, so it rides
 * along with the rest of the confirm form's FormData -- no separate submit/upload step.
 * Pointer events (not touch/mouse handlers) so mouse, touch and pen all work the same way.
 */
export function SignaturePad({
  name = "signature",
  onSignedChange,
}: {
  name?: string;
  onSignedChange?: (signed: boolean) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const drawingRef = useRef(false);
  const [hasSignature, setHasSignature] = useState(false);

  function pointFromEvent(e: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) * canvas.width) / rect.width,
      y: ((e.clientY - rect.top) * canvas.height) / rect.height,
    };
  }

  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drawingRef.current = true;
    const { x, y } = pointFromEvent(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
  }

  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const { x, y } = pointFromEvent(e);
    // Reads the real ink token instead of hardcoding a hex, so this stays correct if
    // --foreground ever changes (e.g. a future dark theme -- see globals.css's .dark block,
    // unused today but already defined).
    ctx.strokeStyle = getComputedStyle(canvas).getPropertyValue("--foreground").trim() || "#201e1d";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineTo(x, y);
    ctx.stroke();
  }

  function commitStroke() {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    const canvas = canvasRef.current;
    if (!canvas || !inputRef.current) return;
    inputRef.current.value = canvas.toDataURL("image/png");
    setHasSignature(true);
    onSignedChange?.(true);
  }

  function handleClear() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (inputRef.current) inputRef.current.value = "";
    setHasSignature(false);
    onSignedChange?.(false);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="relative overflow-hidden rounded-3xl border border-primary/35 bg-card shadow-xs">
        <canvas
          ref={canvasRef}
          width={600}
          height={200}
          className="h-[140px] w-full touch-none"
          // A single "sign above this line" baseline, the same visual idea as the ficha's own
          // ruled table (src/app/ficha/[employeeId]/page.tsx) -- not decoration for its own
          // sake, it tells a first-time worker where to put the pen without any copy at all.
          style={{
            backgroundImage:
              "linear-gradient(color-mix(in srgb, var(--foreground) 22%, transparent), color-mix(in srgb, var(--foreground) 22%, transparent))",
            backgroundSize: "calc(100% - 40px) 1.5px",
            backgroundPosition: "center calc(100% - 34px)",
            backgroundRepeat: "no-repeat",
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={commitStroke}
          onPointerLeave={commitStroke}
        />
        {!hasSignature ? (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-end gap-1.5 pb-9 text-muted-foreground">
            <PenLineIcon className="size-4" aria-hidden="true" />
            <p className="text-sm font-medium">Assine aqui com o dedo</p>
          </div>
        ) : null}
      </div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">Necessário pra confirmar o recebimento.</p>
        <Button type="button" variant="outline" size="sm" onClick={handleClear} disabled={!hasSignature}>
          <EraserIcon aria-hidden="true" />
          Limpar
        </Button>
      </div>
      <input ref={inputRef} type="hidden" name={name} />
    </div>
  );
}
