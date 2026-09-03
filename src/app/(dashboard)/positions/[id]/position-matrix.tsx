"use client";

import { useActionState, useId } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Epi, PositionEpiRequirement } from "@/lib/supabase/dal";
import { useT } from "@/i18n/provider";
import { setPositionEpiRequirement, type MatrixRowState } from "../actions";

const initialState: MatrixRowState = { error: null, ok: false };

/**
 * The matriz cargo x EPI: one row per EPI in the company's catalog (org-wide + this
 * company's own, same set epis/page.tsx lists), each row its own tiny form calling
 * api.set_position_epi_requirement (an upsert) via its own Server Action state -- saving
 * one row never risks another row's unsaved edits.
 */
export function PositionMatrix({
  positionId,
  epis,
  requirements,
}: {
  positionId: string;
  epis: Epi[];
  requirements: PositionEpiRequirement[];
}) {
  const t = useT();

  if (epis.length === 0) {
    return <p className="text-sm text-muted-foreground">{t.positions.matrixNoEpisYet}</p>;
  }

  const byEpi = new Map(requirements.map((r) => [r.epiId, r]));

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t.positions.matrixEpiColumn}</TableHead>
            <TableHead>{t.positions.matrixRequiredColumn}</TableHead>
            <TableHead>{t.positions.matrixQuantityColumn}</TableHead>
            <TableHead>{t.positions.matrixPeriodicityColumn}</TableHead>
            <TableHead>{t.positions.matrixNotesColumn}</TableHead>
            <TableHead className="text-right">{t.common.action}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {epis.map((epi) => (
            <MatrixRow key={epi.id} positionId={positionId} epi={epi} requirement={byEpi.get(epi.id)} />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function MatrixRow({
  positionId,
  epi,
  requirement,
}: {
  positionId: string;
  epi: Epi;
  requirement: PositionEpiRequirement | undefined;
}) {
  const t = useT();
  const [state, formAction, pending] = useActionState(setPositionEpiRequirement, initialState);
  // The row's inputs live in ordinary <td>s (so the table's columns stay aligned) but all
  // point at one <form> rendered alongside them via the HTML `form` attribute -- a <form>
  // element can't legally wrap <tr>/<td> siblings, so this is the standards-based way to
  // have one row submit as one unit.
  const formId = useId();

  return (
    <TableRow>
      <TableCell className="font-bold whitespace-nowrap">
        {epi.name} <span className="font-mono text-[12px] font-normal text-muted-foreground">CA {epi.caNumber}</span>
        <form id={formId} action={formAction} className="hidden">
          <input type="hidden" name="positionId" value={positionId} />
          <input type="hidden" name="epiId" value={epi.id} />
        </form>
      </TableCell>
      <TableCell>
        <Checkbox
          form={formId}
          name="required"
          value="true"
          defaultChecked={requirement?.required ?? true}
          aria-label={t.positions.matrixRequiredColumn}
        />
      </TableCell>
      <TableCell>
        <Input
          form={formId}
          name="quantity"
          type="number"
          min={1}
          max={100}
          defaultValue={requirement?.quantity ?? 1}
          aria-label={t.positions.matrixQuantityColumn}
          className="w-20"
        />
      </TableCell>
      <TableCell>
        <Input
          form={formId}
          name="periodicityDays"
          type="number"
          min={1}
          max={3650}
          defaultValue={requirement?.periodicityDays ?? ""}
          aria-label={t.positions.matrixPeriodicityColumn}
          className="w-24"
        />
      </TableCell>
      <TableCell>
        <Input
          form={formId}
          name="substitutionNotes"
          defaultValue={requirement?.substitutionNotes ?? ""}
          aria-label={t.positions.matrixNotesColumn}
          className="min-w-40"
        />
      </TableCell>
      <TableCell className="text-right">
        <Button type="submit" form={formId} variant="outline" size="sm" disabled={pending}>
          {t.positions.matrixSaveRow}
        </Button>
        {state.error ? <p className="mt-1 max-w-40 text-wrap text-[12px] text-destructive">{state.error}</p> : null}
      </TableCell>
    </TableRow>
  );
}
