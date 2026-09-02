"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import Papa from "papaparse";
import { Button } from "@/components/ui/button";
import { Panel, PanelKicker, PanelTitle } from "@/components/panel";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n/provider";
import type { Dict } from "@/i18n/dictionaries";
import {
  EPI_IMPORT_FIELDS,
  REQUIRED_EPI_IMPORT_FIELDS,
  validateEpiImportRows,
  type EpiColumnMapping,
  type EpiImportField,
  type EpiValidationResult,
  type ParsedCsvRow,
} from "@/lib/csv-import/validate-epi-rows";
import { commitEpiImportChunk, revalidateEpisAfterImport } from "./import-actions";

// One round trip per row on the server (see import-actions.ts) -- keep the chunk small so
// the progress line actually moves.
const CHUNK_SIZE = 50;
// A catalog is dozens of entries, not thousands. This is a sanity guard against someone
// pointing the importer at an employee export by mistake, not a capacity limit.
const MAX_TOTAL_ROWS = 5_000;
const EXAMPLE_ROW = 0;

function fieldLabels(t: Dict): Record<EpiImportField, string> {
  return {
    name: t.common.name,
    ca_number: t.epis.caLabel,
    manufacturer: t.epis.manufacturerLabel,
    model: t.epis.modelLabel,
    description: t.epis.descriptionLabel,
    default_unit: t.epis.defaultUnitLabel,
  };
}

// Loose header-name guesses to pre-fill the mapping step -- purely a UX convenience, the
// user reviews and can override every field before importing.
const HEADER_GUESSES: Record<EpiImportField, string[]> = {
  name: ["nome", "epi", "equipamento", "descricaoepi", "name", "item"],
  ca_number: ["ca", "canumero", "numeroca", "numerodoca", "certificado", "certificadoaprovacao"],
  manufacturer: ["fabricante", "marca", "manufacturer", "brand"],
  model: ["modelo", "model", "referencia", "ref"],
  description: ["descricao", "description", "obs", "observacao", "detalhes"],
  default_unit: ["unidade", "und", "un", "unidademedida", "unit"],
};

function normalizeHeader(header: string): string {
  return header
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function guessMapping(headers: string[]): EpiColumnMapping {
  const mapping: EpiColumnMapping = {};
  for (const field of EPI_IMPORT_FIELDS) {
    const guesses = HEADER_GUESSES[field];
    const match = headers.find((h) => guesses.includes(normalizeHeader(h)));
    if (match) mapping[field] = match;
  }
  return mapping;
}

function errorsToCsv(errors: EpiValidationResult["errors"], t: Dict): string {
  const lines = [`${t.employees.rowLabel},${t.employees.reasonLabel}`];
  for (const e of errors) {
    lines.push(`${e.rowNumber},"${e.reasons.join("; ").replace(/"/g, '""')}"`);
  }
  return lines.join("\n");
}

function downloadCsv(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const selectClassName = cn(
  "h-8 w-full min-w-0 rounded-full border border-input bg-transparent px-3 text-[13px] font-bold text-primary-deep outline-none",
  "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
);

type Step = "upload" | "map" | "committing" | "done";
const STEP_INDEX: Record<Step, number> = { upload: 1, map: 2, committing: 3, done: 3 };

type CommitProgress = {
  processedChunks: number;
  totalChunks: number;
  created: number;
  alreadyInCatalog: number;
  skipped: number;
  failures: { caNumber: string; error: string }[];
};

/**
 * CSV catalog import, built to the same shape as the employee importer (mockup screen 4g):
 * upload, then one screen carrying the column mapping and the problem report side by side,
 * then commit. Validation runs live off the current mapping -- it is pure client-side work
 * (validateEpiImportRows) and nothing reaches the server until the final commit.
 */
export function EpiImportWizard({
  organizationId,
  companyId,
  canCreateOrgWide,
}: {
  organizationId: string;
  companyId: string;
  canCreateOrgWide: boolean;
}) {
  const t = useT();
  const FIELD_LABELS = fieldLabels(t);
  const [step, setStep] = useState<Step>("upload");
  const [fileName, setFileName] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<ParsedCsvRow[]>([]);
  const [mapping, setMapping] = useState<EpiColumnMapping>({});
  const [scope, setScope] = useState<"company" | "org">("company");
  const [commitError, setCommitError] = useState<string | null>(null);
  const [progress, setProgress] = useState<CommitProgress | null>(null);

  const mappingComplete = REQUIRED_EPI_IMPORT_FIELDS.every((f) => !!mapping[f]);
  const validation = useMemo(
    () => (mappingComplete ? validateEpiImportRows(rows, mapping) : null),
    [mappingComplete, rows, mapping],
  );

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setParseError(null);
    setFileName(file.name);

    Papa.parse<ParsedCsvRow>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        if (!results.meta.fields || results.meta.fields.length === 0) {
          setParseError(t.employees.importNoColumnsError);
          return;
        }
        setHeaders(results.meta.fields);
        setRows(results.data);
        setMapping(guessMapping(results.meta.fields));
        setStep("map");
      },
      error: (err: Error) => {
        setParseError(`${t.employees.importReadFailedPrefix} ${err.message}`);
      },
    });
  }

  async function commitImport() {
    if (!validation) return;
    setCommitError(null);
    setStep("committing");

    const chunks: (typeof validation.validRows)[] = [];
    for (let i = 0; i < validation.validRows.length; i += CHUNK_SIZE) {
      chunks.push(validation.validRows.slice(i, i + CHUNK_SIZE));
    }

    let created = 0;
    let alreadyInCatalog = 0;
    let skipped = 0;
    const failures: { caNumber: string; error: string }[] = [];
    setProgress({ processedChunks: 0, totalChunks: chunks.length, created, alreadyInCatalog, skipped, failures });

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const result = await commitEpiImportChunk(
        organizationId,
        companyId,
        scope,
        chunk.map((r) => ({
          name: r.name,
          caNumber: r.caNumber,
          manufacturer: r.manufacturer,
          model: r.model,
          description: r.description,
          defaultUnit: r.defaultUnit,
        })),
      );

      if (!result.ok) {
        setCommitError(
          `${result.error} (${t.employees.batch.toLowerCase()} ${i + 1} ${t.employees.ofConnector} ${chunks.length} -- ${t.employees.batchErrorNote})`,
        );
        setProgress({
          processedChunks: i,
          totalChunks: chunks.length,
          created,
          alreadyInCatalog,
          skipped,
          failures,
        });
        setStep("done");
        return;
      }

      created += result.created;
      alreadyInCatalog += result.alreadyInCatalog;
      skipped += result.skipped;
      failures.push(...result.failures);
      setProgress({
        processedChunks: i + 1,
        totalChunks: chunks.length,
        created,
        alreadyInCatalog,
        skipped,
        failures: [...failures],
      });
    }

    await revalidateEpisAfterImport();
    setStep("done");
  }

  const stepLabel: Record<Step, string> = {
    upload: t.employees.importStepUpload,
    map: t.employees.importStepMap,
    committing: t.employees.importStepCommit,
    done: t.employees.importStepCommit,
  };

  return (
    <div className="flex flex-col gap-5">
      <StepBar current={STEP_INDEX[step]} label={stepLabel[step]} t={t} />

      {step === "upload" ? (
        <Panel className="flex flex-col gap-3.5">
          <PanelTitle>{t.epis.importStep1Title}</PanelTitle>
          <p className="text-[13px] text-muted-foreground">{t.epis.importStep1Description}</p>
          <p className="rounded-2xl bg-secondary px-4 py-3 font-mono text-[12px] text-muted-foreground">
            {t.epis.importHeaderExample}
          </p>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={handleFileChange}
            className="text-sm file:mr-3 file:cursor-pointer file:rounded-full file:border-0 file:bg-primary file:px-4 file:py-2 file:text-sm file:font-extrabold file:text-primary-foreground"
          />
          {parseError ? <p className="text-sm text-destructive">{parseError}</p> : null}
        </Panel>
      ) : null}

      {step === "map" ? (
        <div className="grid grid-cols-1 gap-3.5 xl:grid-cols-[1.55fr_1fr] xl:items-start">
          <div className="flex flex-col gap-3.5">
            <Panel tone="success" className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-4">
                <span className="font-heading text-4xl font-extrabold tracking-tighter tabular-nums">
                  {rows.length}
                </span>
                <span className="min-w-0">
                  <span className="block text-[14px] font-bold">
                    {t.employees.importRowsRead} {fileName}
                  </span>
                  <span className="block text-[12.5px] opacity-80">{t.employees.importNothingSentYet}</span>
                </span>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setStep("upload");
                  setRows([]);
                  setHeaders([]);
                  setMapping({});
                }}
              >
                {t.employees.importChangeFile}
              </Button>
            </Panel>

            <Panel>
              <PanelTitle>{t.employees.importFromTo}</PanelTitle>
              <Table className="mt-3">
                <TableHeader>
                  <TableRow>
                    <TableHead>{t.employees.importFileColumn}</TableHead>
                    <TableHead>{t.employees.importExample}</TableHead>
                    <TableHead>{t.employees.importSeloField}</TableHead>
                    <TableHead className="text-right">{t.common.status}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {EPI_IMPORT_FIELDS.map((field) => {
                    const header = mapping[field];
                    const required = REQUIRED_EPI_IMPORT_FIELDS.includes(field);
                    const example = header ? (rows[EXAMPLE_ROW]?.[header] ?? "") : "";
                    return (
                      <TableRow key={field}>
                        <TableCell>
                          <label className="sr-only" htmlFor={`map-${field}`}>
                            {FIELD_LABELS[field]}
                          </label>
                          <select
                            id={`map-${field}`}
                            className={cn(selectClassName, !header && "text-muted-foreground")}
                            value={header ?? ""}
                            onChange={(e) => setMapping((m) => ({ ...m, [field]: e.target.value || undefined }))}
                          >
                            <option value="">— {t.employees.importIgnore} —</option>
                            {headers.map((h) => (
                              <option key={h} value={h}>
                                {h}
                              </option>
                            ))}
                          </select>
                        </TableCell>
                        <TableCell className="max-w-40 truncate text-muted-foreground">{example || "—"}</TableCell>
                        <TableCell className="font-bold">
                          {FIELD_LABELS[field]}
                          {required ? " *" : ""}
                        </TableCell>
                        <TableCell className="text-right">
                          <MappingState mapped={!!header} required={required} t={t} />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </Panel>

            {canCreateOrgWide ? (
              <Panel className="flex flex-col gap-2.5">
                <PanelKicker className="text-muted-foreground">{t.epis.catalogLabel}</PanelKicker>
                {(
                  [
                    ["company", t.epis.scopeCompanyOnly],
                    ["org", t.epis.scopeOrgWide],
                  ] as const
                ).map(([value, label]) => (
                  <label key={value} className="flex cursor-pointer items-center gap-2.5 text-[13.5px]">
                    <input
                      type="radio"
                      name="scope"
                      value={value}
                      checked={scope === value}
                      onChange={() => setScope(value)}
                      className="accent-primary"
                    />
                    {label}
                  </label>
                ))}
              </Panel>
            ) : null}
          </div>

          <ReviewColumn
            validation={validation}
            mappingComplete={mappingComplete}
            onImport={commitImport}
            onDownloadErrors={(errors) => downloadCsv("erros-importacao-epis.csv", errorsToCsv(errors, t))}
            t={t}
          />
        </div>
      ) : null}

      {step === "committing" ? (
        <Panel className="flex flex-col gap-2">
          <PanelTitle>{t.epis.importing}</PanelTitle>
          <p className="text-[13px] text-muted-foreground">
            {progress
              ? `${t.employees.batch} ${progress.processedChunks} ${t.employees.ofConnector} ${progress.totalChunks} · ${progress.created} ${t.epis.importCreatedSuffix}`
              : t.employees.preparing}
          </p>
        </Panel>
      ) : null}

      {step === "done" ? (
        <Panel className="flex flex-col items-start gap-3.5">
          <PanelTitle>{t.epis.importComplete}</PanelTitle>
          <p className="text-[13.5px]">
            {progress?.created ?? 0} {t.epis.importCreatedSuffix}
            {progress && progress.alreadyInCatalog > 0
              ? `, ${progress.alreadyInCatalog} ${t.epis.importAlreadyInCatalogSuffix}`
              : ""}
            {progress && progress.skipped > 0 ? `, ${progress.skipped} ${t.employees.skippedSuffix}` : ""}.
          </p>
          {progress && progress.failures.length > 0 ? (
            <div className="w-full rounded-2xl bg-destructive-soft px-4 py-3">
              <p className="text-[12.5px] font-bold text-destructive">
                {progress.failures.length} {t.epis.importFailedRows}
              </p>
              <ul className="mt-1.5 flex flex-col gap-0.5 text-[12px]">
                {progress.failures.slice(0, 5).map((failure) => (
                  <li key={failure.caNumber}>
                    <span className="font-mono">{failure.caNumber}</span> — {failure.error}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {commitError ? <p className="text-sm text-destructive">{commitError}</p> : null}
          <Button asChild size="lg">
            <Link href={`/epis?company=${companyId}`}>{t.epis.backToCatalog}</Link>
          </Button>
        </Panel>
      ) : null}
    </div>
  );
}

/** The mockup's three-segment progress bar with "passo N de 3 · <what you are doing>". */
function StepBar({ current, label, t }: { current: number; label: string; t: Dict }) {
  return (
    <div className="flex flex-wrap items-center gap-4">
      <div className="flex gap-1.5">
        {[1, 2, 3].map((n) => (
          <span key={n} className={cn("h-1.5 w-16 rounded-full", n <= current ? "bg-primary" : "bg-foreground/12")} />
        ))}
      </div>
      <p className="text-[10.5px] font-bold tracking-[0.12em] text-muted-foreground uppercase">
        {t.employees.importStepPrefix} {current} {t.employees.ofConnector} 3 · {label}
      </p>
    </div>
  );
}

function MappingState({ mapped, required, t }: { mapped: boolean; required: boolean; t: Dict }) {
  if (mapped) {
    return (
      <span className="inline-flex h-6.5 items-center rounded-full bg-success-soft px-3 text-[11.5px] font-bold text-success">
        {t.employees.importMapped}
      </span>
    );
  }
  if (required) {
    return (
      <span className="inline-flex h-6.5 items-center rounded-full bg-destructive-soft px-3 text-[11.5px] font-bold text-destructive">
        {t.employees.importPending}
      </span>
    );
  }
  return (
    <span className="inline-flex h-6.5 items-center rounded-full bg-foreground/6 px-3 text-[11.5px] font-bold text-muted-foreground">
      {t.employees.importIgnored}
    </span>
  );
}

function ReviewColumn({
  validation,
  mappingComplete,
  onImport,
  onDownloadErrors,
  t,
}: {
  validation: EpiValidationResult | null;
  mappingComplete: boolean;
  onImport: () => void;
  onDownloadErrors: (errors: EpiValidationResult["errors"]) => void;
  t: Dict;
}) {
  if (!mappingComplete || !validation) {
    return (
      <Panel tone="destructive" className="flex flex-col gap-2">
        <PanelKicker className="text-destructive">{t.epis.importNameAndCaRequired}</PanelKicker>
        <p className="text-[12.5px] text-muted-foreground">{t.epis.importMapRequiredHint}</p>
      </Panel>
    );
  }

  const overCap = validation.validRows.length > MAX_TOTAL_ROWS;
  const firstErrors = validation.errors.slice(0, 4);

  return (
    <div className="flex flex-col gap-3.5">
      {validation.errors.length > 0 ? (
        <Panel tone="destructive" className="flex flex-col items-start gap-3">
          <PanelKicker className="text-destructive">
            {validation.errors.length} {t.employees.importRowsWithProblems}
          </PanelKicker>
          <ul className="flex flex-col gap-1 text-[12.5px]">
            {firstErrors.map((error) => (
              <li key={error.rowNumber}>
                <span className="font-bold">
                  {t.employees.rowLabel} {error.rowNumber}
                </span>{" "}
                — {error.reasons.join("; ")}
              </li>
            ))}
            {validation.errors.length > firstErrors.length ? (
              <li className="text-muted-foreground">
                + {validation.errors.length - firstErrors.length} {t.employees.importMoreRows}
              </li>
            ) : null}
          </ul>
          <Button type="button" variant="outline" onClick={() => onDownloadErrors(validation.errors)}>
            {t.employees.downloadErrorReport}
          </Button>
        </Panel>
      ) : null}

      <Panel className="flex flex-col gap-3.5">
        <p className="font-heading text-5xl font-extrabold tracking-tighter tabular-nums">
          {validation.validRows.length}
        </p>
        <p className="text-[13px] text-muted-foreground">{t.epis.importWillBeCreated}</p>
        {overCap ? (
          <p className="text-[13px] text-destructive">
            {t.epis.importOverCapPrefix} {MAX_TOTAL_ROWS.toLocaleString("pt-BR")} {t.epis.importOverCapSuffix}
          </p>
        ) : null}
        <Button
          type="button"
          size="lg"
          className="w-full"
          onClick={onImport}
          disabled={validation.validRows.length === 0 || overCap}
        >
          {t.epis.confirmImport}
        </Button>
      </Panel>
    </div>
  );
}
