"use client";

import { useActionState, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogClose,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { submitConfirm, submitContest, type ConfirmState, type ContestState } from "./actions";

type Item = { epi_name: string; ca_number: string; manufacturer: string | null; model: string | null; quantity: number; unit: string };

const CONTEST_REASONS: { value: string; label: string }[] = [
  { value: "NOT_RECEIVED", label: "Não recebi este material" },
  { value: "WRONG_ITEM", label: "O item está errado" },
  { value: "WRONG_QUANTITY", label: "A quantidade está errada" },
  { value: "ALREADY_RETURNED", label: "Já devolvi este material" },
  { value: "OTHER", label: "Outro motivo" },
];

const confirmInitialState: ConfirmState = { error: null, attemptsRemaining: null };
const contestInitialState: ContestState = { error: null };

/**
 * The worker review/confirm/contest screen. Rendered fresh (key={nonce}) by the parent page
 * on every server round-trip -- this is what makes the hidden nonce input always carry the
 * CURRENT live nonce, even after a failed attempt (identity mismatch consumes the nonce and
 * the server issues a new one on the next render; without remounting, the hidden
 * `defaultValue` would keep the stale, already-consumed value and every retry would fail as
 * a replay).
 */
export function ReviewForm({
  viewId,
  nonce,
  companyName,
  employeeFullName,
  deliveryDate,
  note,
  requiredAssuranceLevel,
  identityAttempts,
  identityMaxAttempts,
  items,
}: {
  viewId: string;
  nonce: string;
  companyName: string;
  employeeFullName: string;
  deliveryDate: string;
  note: string | null;
  requiredAssuranceLevel: string;
  identityAttempts: number;
  identityMaxAttempts: number;
  items: Item[];
}) {
  const [confirmState, confirmAction, confirmPending] = useActionState(submitConfirm, confirmInitialState);
  const [contestState, contestAction, contestPending] = useActionState(submitContest, contestInitialState);
  const [contestOpen, setContestOpen] = useState(false);
  const idPrefix = useId();
  const remaining = Math.max(0, identityMaxAttempts - identityAttempts);

  return (
    <main className="mx-auto flex min-h-svh max-w-md flex-col gap-4 px-4 py-6">
      <header className="flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">{companyName}</p>
        <h1 className="text-lg font-semibold">Confirmação de recebimento de EPI</h1>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{employeeFullName}</CardTitle>
          <CardDescription>
            Entrega de {new Date(`${deliveryDate}T00:00:00`).toLocaleDateString("pt-BR")}
            {note ? ` — ${note}` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {items.map((item, i) => (
            <div key={i} className="flex items-start justify-between gap-3 border-b pb-3 last:border-b-0 last:pb-0">
              <div>
                <p className="text-sm font-medium">{item.epi_name}</p>
                <p className="text-xs text-muted-foreground">
                  CA {item.ca_number}
                  {item.manufacturer ? ` · ${item.manufacturer}` : ""}
                  {item.model ? ` · ${item.model}` : ""}
                </p>
              </div>
              <p className="shrink-0 text-sm font-medium">
                {item.quantity} {item.unit}
              </p>
            </div>
          ))}
        </CardContent>
      </Card>

      <form action={confirmAction} className="flex flex-col gap-3">
        <input type="hidden" name="viewId" value={viewId} />
        <input type="hidden" name="nonce" value={nonce} />
        <input type="hidden" name="requiredAssuranceLevel" value={requiredAssuranceLevel} />

        {requiredAssuranceLevel === "AL1_LINK_KNOWLEDGE" ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${idPrefix}-cpf3`}>Confirme os 3 últimos números do seu CPF</Label>
            <Input
              id={`${idPrefix}-cpf3`}
              name="cpfLast3"
              inputMode="numeric"
              pattern="\d{3}"
              maxLength={3}
              required
              autoComplete="off"
              className="w-24 text-center text-lg tracking-widest"
            />
            {remaining < identityMaxAttempts ? (
              <p className={cn("text-xs", remaining <= 1 ? "text-destructive" : "text-muted-foreground")}>
                {remaining > 0 ? `${remaining} tentativa(s) restante(s).` : "Nenhuma tentativa restante."}
              </p>
            ) : null}
          </div>
        ) : null}

        {confirmState.error ? <p className="text-sm text-destructive">{confirmState.error}</p> : null}

        <Button type="submit" size="lg" disabled={confirmPending}>
          {confirmPending ? "Confirmando…" : "Confirmar recebimento"}
        </Button>
      </form>

      <Dialog open={contestOpen} onOpenChange={setContestOpen}>
        <DialogTrigger asChild>
          <Button type="button" variant="outline">
            Não recebi / algo está errado
          </Button>
        </DialogTrigger>
        <DialogContent>
          <form action={contestAction} className="flex flex-col gap-4">
            <input type="hidden" name="viewId" value={viewId} />
            <input type="hidden" name="nonce" value={nonce} />
            <DialogHeader>
              <DialogTitle>Contestar esta entrega</DialogTitle>
              <DialogDescription>
                Isso não confirma o recebimento. O gestor será notificado do motivo.
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-2">
              <Label htmlFor={`${idPrefix}-reason`}>Motivo</Label>
              <select
                id={`${idPrefix}-reason`}
                name="reasonCode"
                required
                defaultValue=""
                className="h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <option value="" disabled>
                  Selecione um motivo
                </option>
                {CONTEST_REASONS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor={`${idPrefix}-comment`}>Comentário (opcional)</Label>
              <textarea
                id={`${idPrefix}-comment`}
                name="comment"
                rows={3}
                maxLength={2000}
                className="w-full rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              />
            </div>

            {contestState.error ? <p className="text-sm text-destructive">{contestState.error}</p> : null}

            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancelar
                </Button>
              </DialogClose>
              <Button type="submit" variant="destructive" disabled={contestPending}>
                {contestPending ? "Enviando…" : "Enviar contestação"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </main>
  );
}
