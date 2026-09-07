"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import Papa from "papaparse";
import { Button } from "@/components/ui/button";
import { Panel, PanelKicker, PanelTitle } from "@/components/panel";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { useLocale, useT } from "@/i18n/provider";
import type { Dict } from "@/i18n/dictionaries";
import {
  IMPORT_FIELDS,
  REQUIRED_IMPORT_FIELDS,
  validateImportRows,
  type ColumnMapping,
  type ImportField,
  type ParsedCsvRow,
  type ValidationResult,
} from "@/lib/csv-import/validate-rows";
import {
  applyReferenceResolution,
  collectReferenceLabels,
  type ResolvedRow,
} from "@/lib/csv-import/resolve-references";
import { neutralizeFormula, readXlsxRows, XlsxRejectedError } from "@/lib/csv-import/xlsx";
import {
  commitEmployeeImportChunk,
  finishImportRun,
  resolveImportReferences,
  revalidateEmployeesAfterImport,
  startImportRun,
} from "./import-actions";

// Hard cap mirrors api.import_employees_commit's own limit (batch_too_large, code 54000,
// supabase/migrations/20260831150200_employee_rpcs.sql) -- refused here with a clear
// message rather than letting the RPC reject it blind partway through a long upload.
const MAX_TOTAL_ROWS = 20_000;
// Client-side chunk size for sequential commits -- keeps each Server Action call's body
// small and gives the user real progress feedback on a large file. Must stay <=
// MAX_ROWS_PER_CALL in import-actions.ts.
const CHUNK_SIZE = 2000;
// How many mapped rows the "de -> para" table shows an example value from.
const EXAMPLE_ROW = 0;

function fieldLabels(t: Dict): Record<ImportField, string> {
  return {
    full_name: t.employees.fullNameLabel,
    cpf: t.employees.cpfLabel,
    registration_number: t.employees.registrationNumberLabel,
    phone: t.employees.phoneLabel,
    email: t.common.email,
    position_title: t.employees.positionLabel,
    department: t.employees.departmentLabel,
    location: t.employees.importUnitLabel,
  };
}

// Loose header-name guesses to pre-fill the mapping step -- purely a UX convenience, the
// user reviews and can override every field before importing.
const HEADER_GUESSES: Record<ImportField, string[]> = {
  full_name: ["nome", "nomecompleto", "funcionario", "colaborador", "name"],
  cpf: ["cpf"],
  registration_number: ["matricula", "registro", "registration", "codigo"],
  phone: ["telefone", "celular", "fone", "phone", "whatsapp"],
  email: ["email", "e-mail"],
  position_title: ["cargo", "funcao", "posicao", "position"],
  department: ["departamento", "setor", "department", "area"],
  location: ["unidade", "local", "filial", "obra", "site", "location", "unit"],
};

function normalizeHeader(header: string): string {
  return header
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "") // strip combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function guessMapping(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  for (const field of IMPORT_FIELDS) {
    const guesses = HEADER_GUESSES[field];
    const match = headers.find((h) => guesses.includes(normalizeHeader(h)));
    if (match) mapping[field] = match;
  }
  return mapping;
}

function errorsToCsv(errors: ValidationResult["errors"], t: Dict): string {
  const lines = [`${t.employees.rowLabel},${t.employees.reasonLabel}`];
  for (const e of errors) {
    // neutralizeFormula because THIS file is the real formula-injection vector: the reasons
    // quote values the user uploaded, and they open our export in Excel. A cell starting
    // with "=" would execute there, in their session, from their own spreadsheet.
    const reason = neutralizeFormula(e.reasons.join("; ")).replace(/"/g, '""');
    lines.push(`${e.rowNumber},"${reason}"`);
  }
  return lines.join("\n");
}

/** XLSX comes back as a raw grid; the CSV path is header-keyed. Converting here keeps ONE
 * downstream validation path instead of two. */
function gridToRows(grid: string[][]): { headers: string[]; rows: ParsedCsvRow[] } {
  const [headerRow, ...dataRows] = grid;
  const headers = (headerRow ?? []).map((h, i) => (h.trim() === "" ? `Coluna ${i + 1}` : h.trim()));
  const rows = dataRows.map((cells) => {
    const row: ParsedCsvRow = {};
    headers.forEach((header, i) => {
      row[header] = cells[i] ?? "";
    });
    return row;
  });
  return { headers, rows };
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
  updated: number;
  skipped: number;
};

/**
 * CSV import, laid out from the mockup (screen 4g). The mockup shows one "conferir as
 * colunas" screen that carries the column mapping *and* the problem report side by side,
 * so validation runs live off the current mapping rather than behind a separate "validar"
 * step -- it is pure client-side work (validateImportRows) and nothing is sent to the
 * server until the final commit, exactly as before.
 */
export function ImportWizard({ companyId }: { companyId: string }) {
  const t = useT();
  const locale = useLocale();
  const FIELD_LABELS = fieldLabels(t);
  const [step, setStep] = useState<Step>("upload");
  const [fileName, setFileName] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<ParsedCsvRow[]>([]);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [commitError, setCommitError] = useState<string | null>(null);
  const [progress, setProgress] = useState<CommitProgress | null>(null);
  const [sourceFormat, setSourceFormat] = useState<"CSV" | "XLSX">("CSV");
  const [resolving, setResolving] = useState(false);
  /** True when at least one chunk committed and at least one did not. Kept separate from
   * commitError so the UI can never show an unqualified "concluída" over a partial file. */
  const [partial, setPartial] = useState(false);
  /** Rows rejected because their Cargo/Unidade did not resolve. Surfaced alongside the
   * validation errors so the user sees every reason a row was left out, in one place. */
  const [resolutionErrors, setResolutionErrors] = useState<ValidationResult["errors"]>([]);

  const mappingComplete = REQUIRED_IMPORT_FIELDS.every((f) => !!mapping[f]);
  const validation = useMemo(
    () => (mappingComplete ? validateImportRows(rows, mapping) : null),
    [mappingComplete, rows, mapping],
  );

  function describeXlsxRejection(reason: XlsxRejectedError["reason"]): string {
    switch (reason) {
      case "file_too_large":
        return t.employees.importXlsxTooLarge;
      case "not_a_zip":
        return t.employees.importXlsxNotAZip;
      case "uncompressed_too_large":
      case "compression_ratio":
      case "too_many_entries":
        return t.employees.importXlsxBomb;
      case "too_many_rows":
        return t.employees.importXlsxTooManyRows;
      default:
        return t.employees.importXlsxCorrupt;
    }
  }

  async function handleXlsx(file: File) {
    try {
      const grid = await readXlsxRows(file);
      const { headers: xlsxHeaders, rows: xlsxRows } = gridToRows(grid);
      if (xlsxHeaders.length === 0) {
        setParseError(t.employees.importNoColumnsError);
        return;
      }
      setSourceFormat("XLSX");
      setHeaders(xlsxHeaders);
      setRows(xlsxRows);
      setMapping(guessMapping(xlsxHeaders));
      setStep("map");
    } catch (error) {
      setParseError(
        error instanceof XlsxRejectedError
          ? `${t.employees.importXlsxRejected}: ${describeXlsxRejection(error.reason)}`
          : `${t.employees.importReadFailedPrefix} ${(error as Error).message}`,
      );
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setParseError(null);
    setFileName(file.name);

    if (/\.xlsx$/i.test(file.name)) {
      void handleXlsx(file);
      return;
    }

    setSourceFormat("CSV");
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
    setPartial(false);

    // Resolve Cargo/Unidade BEFORE anything is written. A label that does not match becomes
    // a row error the user fixes; nothing is ever created on their behalf.
    let rowsToImport: ResolvedRow[] = validation.validRows.map((r) => ({
      ...r,
      positionId: null,
      locationId: null,
    }));
    let referenceErrors: ValidationResult["errors"] = [];

    const labels = collectReferenceLabels(validation.validRows);
    if (labels.titles.length > 0 || labels.locationRefs.length > 0) {
      setResolving(true);
      const resolved = await resolveImportReferences(companyId, labels.titles, labels.locationRefs);
      setResolving(false);
      if (!resolved.ok) {
        setCommitError(resolved.error);
        return;
      }
      const applied = applyReferenceResolution(validation.validRows, resolved.resolutions);
      rowsToImport = applied.resolvedRows;
      referenceErrors = applied.errors;
    }

    if (rowsToImport.length === 0) {
      setResolutionErrors(referenceErrors);
      setCommitError(t.employees.importReferencesFailed);
      return;
    }
    setResolutionErrors(referenceErrors);
    setStep("committing");

    const chunks: ResolvedRow[][] = [];
    for (let i = 0; i < rowsToImport.length; i += CHUNK_SIZE) {
      chunks.push(rowsToImport.slice(i, i + CHUNK_SIZE));
    }

    // Opened before the first chunk so a crash mid-import still leaves an inspectable run.
    const run = await startImportRun({
      companyId,
      sourceFormat,
      sourceFilename: fileName,
      columnMapping: mapping,
      totalRows: rows.length,
      validRows: rowsToImport.length,
      errorRows: validation.errors.length + referenceErrors.length,
      chunkSize: CHUNK_SIZE,
      chunkCount: chunks.length,
    });
    if (!run.ok) {
      setCommitError(run.error);
      setStep("done");
      return;
    }

    let created = 0;
    let updated = 0;
    let skipped = 0;
    setProgress({ processedChunks: 0, totalChunks: chunks.length, created, updated, skipped });

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const result = await commitEmployeeImportChunk(
        companyId,
        chunk.map((r) => ({
          fullName: r.fullName,
          cpf: r.cpf,
          registrationNumber: r.registrationNumber,
          phone: r.phone,
          email: r.email,
          positionTitle: r.positionTitle,
          department: r.department,
          positionId: r.positionId,
          locationId: r.locationId,
        })),
        {
          importRunId: run.importRunId,
          chunkIndex: i,
          rowFrom: chunk[0]?.rowNumber ?? 0,
          rowTo: chunk[chunk.length - 1]?.rowNumber ?? 0,
        },
      );

      if (!result.ok) {
        setCommitError(
          `${result.error} (${t.employees.batch.toLowerCase()} ${i + 1} ${t.employees.ofConnector} ${chunks.length} -- ${t.employees.batchErrorNote})`,
        );
        setProgress({ processedChunks: i, totalChunks: chunks.length, created, updated, skipped });
        // The run's real status comes from what actually committed in the database, not from
        // what this loop believes -- so a failure here still records PARTIAL truthfully.
        const finished = await finishImportRun(run.importRunId);
        setPartial(finished.ok ? finished.status === "PARTIAL" : i > 0);
        setStep("done");
        return;
      }

      created += result.created;
      updated += result.updated;
      skipped += result.skipped;
      setProgress({ processedChunks: i + 1, totalChunks: chunks.length, created, updated, skipped });
    }

    const finished = await finishImportRun(run.importRunId);
    setPartial(finished.ok && finished.status === "PARTIAL");
    await revalidateEmployeesAfterImport();
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
          <PanelTitle>{t.employees.importStep1Title}</PanelTitle>
          <p className="text-[13px] text-muted-foreground">{t.employees.importStep1Description}</p>
          <input
            type="file"
            accept=".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
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
                  {IMPORT_FIELDS.map((field) => {
                    const header = mapping[field];
                    const required = REQUIRED_IMPORT_FIELDS.includes(field);
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
          </div>

          <ReviewColumn
            validation={validation}
            mappingComplete={mappingComplete}
            locale={locale}
            onImport={commitImport}
            onDownloadErrors={(errors) => downloadCsv("erros-importacao.csv", errorsToCsv(errors, t))}
            t={t}
          />
        </div>
      ) : null}

      {step === "committing" ? (
        <Panel className="flex flex-col gap-2">
          <PanelTitle>{t.employees.importing}</PanelTitle>
          <p className="text-[13px] text-muted-foreground">
            {progress
              ? `${t.employees.batch} ${progress.processedChunks} ${t.employees.ofConnector} ${progress.totalChunks}…`
              : resolving ? t.employees.importResolvingReferences : t.employees.preparing}
          </p>
        </Panel>
      ) : null}

      {step === "done" ? (
        <Panel tone={partial ? "destructive" : undefined} className="flex flex-col items-start gap-3.5">
          <PanelTitle>{partial ? t.employees.importPartialTitle : t.employees.importComplete}</PanelTitle>
          {partial ? (
            <>
              <p className="text-[13.5px]">{t.employees.importPartialDescription}</p>
              {progress ? (
                <p className="text-[13px] font-bold tabular-nums">
                  {progress.processedChunks} {t.employees.importChunksCommitted} {progress.totalChunks}
                </p>
              ) : null}
              <p className="text-[12.5px] text-muted-foreground">{t.employees.importResumeHint}</p>
            </>
          ) : null}
          <p className="text-[13.5px]">
            {progress?.created ?? 0} {t.employees.createdSuffix} {progress?.updated ?? 0} {t.employees.updatedSuffix}
            {progress && progress.skipped > 0 ? `, ${progress.skipped} ${t.employees.skippedSuffix}` : ""}.
          </p>
          {commitError ? <p className="text-sm text-destructive">{commitError}</p> : null}
          {resolutionErrors.length > 0 ? (
            <div className="flex flex-col items-start gap-2">
              <p className="text-[13px] font-bold text-destructive">
                {resolutionErrors.length} {t.employees.importRowsWithProblems}
              </p>
              <ul className="flex flex-col gap-1 text-[12.5px]">
                {resolutionErrors.slice(0, 4).map((error) => (
                  <li key={error.rowNumber}>
                    <span className="font-bold">
                      {t.employees.rowLabel} {error.rowNumber}
                    </span>{" "}
                    — {error.reasons.join("; ")}
                  </li>
                ))}
                {resolutionErrors.length > 4 ? (
                  <li className="text-muted-foreground">
                    + {resolutionErrors.length - 4} {t.employees.importMoreRows}
                  </li>
                ) : null}
              </ul>
              <Button
                type="button"
                variant="outline"
                onClick={() => downloadCsv("erros-importacao.csv", errorsToCsv(resolutionErrors, t))}
              >
                {t.employees.downloadErrorReport}
              </Button>
            </div>
          ) : null}
          <Button asChild size="lg">
            <Link href={`/employees?company=${companyId}`}>{t.companies.viewEmployees}</Link>
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
          <span
            key={n}
            className={cn("h-1.5 w-16 rounded-full", n <= current ? "bg-primary" : "bg-foreground/12")}
          />
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

/** The mockup's right-hand column: what is wrong with the file, then what will happen. */
function ReviewColumn({
  validation,
  mappingComplete,
  locale,
  onImport,
  onDownloadErrors,
  t,
}: {
  validation: ValidationResult | null;
  mappingComplete: boolean;
  locale: string;
  onImport: () => void;
  onDownloadErrors: (errors: ValidationResult["errors"]) => void;
  t: Dict;
}) {
  if (!mappingComplete || !validation) {
    return (
      <Panel tone="destructive" className="flex flex-col gap-2">
        <PanelKicker className="text-destructive">{t.employees.importNameAndCpfRequired}</PanelKicker>
        <p className="text-[12.5px] text-muted-foreground">{t.employees.importMapRequiredHint}</p>
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
        <p className="text-[13px] text-muted-foreground">{t.employees.importWillBeCreatedActive}</p>
        {overCap ? (
          <p className="text-[13px] text-destructive">
            {t.employees.importOverCapPrefix} {MAX_TOTAL_ROWS.toLocaleString(locale === "pt" ? "pt-BR" : "en-US")}{" "}
            {t.employees.importOverCapSuffix}
          </p>
        ) : null}
        <Button
          type="button"
          size="lg"
          className="w-full"
          onClick={onImport}
          disabled={validation.validRows.length === 0 || overCap}
        >
          {t.employees.confirmImport}
        </Button>
      </Panel>
    </div>
  );
}
