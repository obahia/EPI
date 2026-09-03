"use client";

import Link from "next/link";

/**
 * The only interactive part of the ficha, and the only part that must not appear on paper.
 * `print:hidden` takes it out of the printed sheet; window.print() is what turns the page
 * into a PDF, so no PDF library is involved anywhere.
 */
export function PrintButton() {
  return (
    <div className="mb-6 flex items-center justify-between gap-4 print:hidden">
      <Link href="/employees" className="text-[13px] font-bold text-[#8c491a] underline-offset-4 hover:underline">
        ← Voltar
      </Link>
      <button
        type="button"
        onClick={() => window.print()}
        className="cursor-pointer rounded-full bg-[#c67139] px-5 py-2.5 text-[13px] font-extrabold text-[#f5ead8]"
      >
        Imprimir / Salvar em PDF
      </button>
    </div>
  );
}
