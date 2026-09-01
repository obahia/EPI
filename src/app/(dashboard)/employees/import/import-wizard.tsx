"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import Papa from "papaparse";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
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
import { commitEmployeeImportChunk, revalidateEmployeesAfterImport } from "./import-actions";

// Hard cap mirrors api.import_employees_commit's own limit (batch_too_large, code 54000,
// supabase/migrations/20260831150200_employee_rpcs.sql) -- refused here with a clear
// message rather than letting the RPC reject it blind partway through a long upload.
const MAX_TOTAL_ROWS = 20_000;
// Client-side chunk size for sequential commits -- keeps each Server Action call's body
// small and gives the user real progress feedback on a large file. Must stay <=
// MAX_ROWS_PER_CALL in import-actions.ts.
const CHUNK_SIZE = 2000;

function fieldLabels(t: Dict): Record<ImportField, string> {
  return {
    full_name: t.employees.fullNameLabel,
    cpf: t.employees.cpfLabel,
    registration_number: t.employees.registrationNumberLabel,
    phone: t.employees.phoneLabel,
    email: t.common.email,
    position_title: t.employees.positionLabel,
    department: t.employees.departmentLabel,
  };
}

// Loose header-name guesses to pre-fill the mapping step -- purely a UX convenience, the
// user reviews and can override every field before validating.
const HEADER_GUESSES: Record<ImportField, string[]> = {
  full_name: ["nome", "nomecompleto", "funcionario", "colaborador", "name"],
  cpf: ["cpf"],
  registration_number: ["matricula", "registro", "registration", "codigo"],
  phone: ["telefone", "celular", "fone", "phone", "whatsapp"],
  email: ["email", "e-mail"],
  position_title: ["cargo", "funcao", "posicao", "position"],
  department: ["departamento", "setor", "department", "area"],
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
  "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none",
  "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30",
);

type Step = "upload" | "map" | "review" | "committing" | "done";

type CommitProgress = { processedChunks: number; totalChunks: number; created: number; updated: number; skipped: number };

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
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [progress, setProgress] = useState<CommitProgress | null>(null);

  const previewRows = useMemo(() => rows.slice(0, 5), [rows]);
  const mappingComplete = REQUIRED_IMPORT_FIELDS.every((f) => !!mapping[f]);

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

  function runValidation() {
    const result = validateImportRows(rows, mapping);
    setValidation(result);
    setStep("review");
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
        })),
      );

      if (!result.ok) {
        setCommitError(
          `${result.error} (${t.employees.batch.toLowerCase()} ${i + 1} ${t.employees.ofConnector} ${chunks.length} -- ${t.employees.batchErrorNote})`,
        );
        setProgress({ processedChunks: i, totalChunks: chunks.length, created, updated, skipped });
        setStep("done");
        return;
      }

      created += result.created;
      updated += result.updated;
      skipped += result.skipped;
      setProgress({ processedChunks: i + 1, totalChunks: chunks.length, created, updated, skipped });
    }

    await revalidateEmployeesAfterImport();
    setStep("done");
  }

  if (step === "upload") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t.employees.importStep1Title}</CardTitle>
          <CardDescription>{t.employees.importStep1Description}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={handleFileChange}
            className="text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-primary-foreground"
          />
          {fileName ? (
            <p className="text-sm text-muted-foreground">
              {t.employees.importFileLabel} {fileName}
            </p>
          ) : null}
          {parseError ? <p className="text-sm text-destructive">{parseError}</p> : null}
        </CardContent>
      </Card>
    );
  }

  if (step === "map") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t.employees.importStep2Title}</CardTitle>
          <CardDescription>
            {rows.length} {t.employees.importRowsFoundSuffix} {fileName}. {t.employees.importNameAndCpfRequired}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {IMPORT_FIELDS.map((field) => (
              <div key={field} className="flex flex-col gap-2">
                <Label htmlFor={`map-${field}`}>
                  {FIELD_LABELS[field]}
                  {REQUIRED_IMPORT_FIELDS.includes(field) ? " *" : ""}
                </Label>
                <select
                  id={`map-${field}`}
                  className={selectClassName}
                  value={mapping[field] ?? ""}
                  onChange={(e) => setMapping((m) => ({ ...m, [field]: e.target.value || undefined }))}
                >
                  <option value="">{t.employees.importDoNotImport}</option>
                  {headers.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>

          <div>
            <p className="mb-2 text-sm font-medium">
              {t.employees.importPreviewPrefix} {previewRows.length} {t.employees.importPreviewSuffix}
            </p>
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    {IMPORT_FIELDS.map((field) => (
                      <TableHead key={field}>{FIELD_LABELS[field]}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {previewRows.map((row, i) => (
                    <TableRow key={i}>
                      {IMPORT_FIELDS.map((field) => (
                        <TableCell key={field}>{mapping[field] ? (row[mapping[field]!] ?? "") : "—"}</TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>

          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setStep("upload")}>
              {t.common.back}
            </Button>
            <Button onClick={runValidation} disabled={!mappingComplete}>
              {t.employees.validate}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (step === "review" && validation) {
    const overCap = validation.validRows.length > MAX_TOTAL_ROWS;
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t.employees.importStep3Title}</CardTitle>
          <CardDescription>
            {validation.validRows.length} {t.employees.importValidRowsSuffix} {validation.errors.length}{" "}
            {t.employees.importErrorRowsSuffix}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {overCap ? (
            <p className="text-sm text-destructive">
              {t.employees.importOverCapPrefix} {MAX_TOTAL_ROWS.toLocaleString(locale === "pt" ? "pt-BR" : "en-US")}{" "}
              {t.employees.importOverCapSuffix}
            </p>
          ) : null}

          {validation.errors.length > 0 ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">{t.employees.importErrorRowsTitle}</p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => downloadCsv("erros-importacao.csv", errorsToCsv(validation.errors, t))}
                >
                  {t.employees.downloadErrorReport}
                </Button>
              </div>
              <div className="max-h-64 overflow-y-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t.employees.rowLabel}</TableHead>
                      <TableHead>{t.employees.reasonLabel}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {validation.errors.map((e) => (
                      <TableRow key={e.rowNumber}>
                        <TableCell>{e.rowNumber}</TableCell>
                        <TableCell className="whitespace-normal text-destructive">{e.reasons.join("; ")}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          ) : null}

          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setStep("map")}>
              {t.common.back}
            </Button>
            <Button onClick={commitImport} disabled={validation.validRows.length === 0 || overCap}>
              {t.employees.confirmImport}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (step === "committing") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t.employees.importing}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {progress
              ? `${t.employees.batch} ${progress.processedChunks} ${t.employees.ofConnector} ${progress.totalChunks}…`
              : t.employees.preparing}
          </p>
        </CardContent>
      </Card>
    );
  }

  // step === "done"
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.employees.importComplete}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm">
          {progress?.created ?? 0} {t.employees.createdSuffix} {progress?.updated ?? 0} {t.employees.updatedSuffix}
          {progress && progress.skipped > 0 ? `, ${progress.skipped} ${t.employees.skippedSuffix}` : ""}.
        </p>
        {commitError ? <p className="text-sm text-destructive">{commitError}</p> : null}
        <div>
          <Button asChild>
            <Link href={`/employees?company=${companyId}`}>{t.companies.viewEmployees}</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
