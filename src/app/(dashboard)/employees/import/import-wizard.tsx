"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import Papa from "papaparse";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
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

const FIELD_LABELS: Record<ImportField, string> = {
  full_name: "Nome completo",
  cpf: "CPF",
  registration_number: "Matrícula",
  phone: "Telefone",
  email: "E-mail",
  position_title: "Cargo",
  department: "Departamento",
};

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

function errorsToCsv(errors: ValidationResult["errors"]): string {
  const lines = ["linha,motivo"];
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
          setParseError("Não foi possível ler colunas neste arquivo. Confira se a primeira linha tem cabeçalhos.");
          return;
        }
        setHeaders(results.meta.fields);
        setRows(results.data);
        setMapping(guessMapping(results.meta.fields));
        setStep("map");
      },
      error: (err: Error) => {
        setParseError(`Falha ao ler o arquivo: ${err.message}`);
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
        setCommitError(`${result.error} (lote ${i + 1} de ${chunks.length} -- os lotes anteriores já foram salvos)`);
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
          <CardTitle>1. Enviar arquivo</CardTitle>
          <CardDescription>
            Arquivo .csv com uma linha de cabeçalho. Nada é enviado ao servidor nesta etapa -- a leitura acontece no
            seu navegador.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={handleFileChange}
            className="text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-primary-foreground"
          />
          {fileName ? <p className="text-sm text-muted-foreground">Arquivo: {fileName}</p> : null}
          {parseError ? <p className="text-sm text-destructive">{parseError}</p> : null}
        </CardContent>
      </Card>
    );
  }

  if (step === "map") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>2. Mapear colunas</CardTitle>
          <CardDescription>{rows.length} linha(s) encontradas em {fileName}. Nome e CPF são obrigatórios.</CardDescription>
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
                  <option value="">— não importar —</option>
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
            <p className="mb-2 text-sm font-medium">Pré-visualização (primeiras {previewRows.length} linhas)</p>
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
              Voltar
            </Button>
            <Button onClick={runValidation} disabled={!mappingComplete}>
              Validar
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
          <CardTitle>3. Revisar</CardTitle>
          <CardDescription>
            {validation.validRows.length} linha(s) válida(s), {validation.errors.length} com erro.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {overCap ? (
            <p className="text-sm text-destructive">
              O arquivo tem mais de {MAX_TOTAL_ROWS.toLocaleString("pt-BR")} linhas válidas. Divida o arquivo em
              partes menores e importe cada uma separadamente.
            </p>
          ) : null}

          {validation.errors.length > 0 ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">Linhas com erro</p>
                <Button size="sm" variant="outline" onClick={() => downloadCsv("erros-importacao.csv", errorsToCsv(validation.errors))}>
                  Baixar relatório de erros
                </Button>
              </div>
              <div className="max-h-64 overflow-y-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Linha</TableHead>
                      <TableHead>Motivo</TableHead>
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
              Voltar
            </Button>
            <Button onClick={commitImport} disabled={validation.validRows.length === 0 || overCap}>
              Confirmar importação
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
          <CardTitle>Importando…</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {progress ? `Lote ${progress.processedChunks} de ${progress.totalChunks}…` : "Preparando…"}
          </p>
        </CardContent>
      </Card>
    );
  }

  // step === "done"
  return (
    <Card>
      <CardHeader>
        <CardTitle>Importação concluída</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm">
          {progress?.created ?? 0} criados, {progress?.updated ?? 0} atualizados
          {progress && progress.skipped > 0 ? `, ${progress.skipped} ignorados na revalidação` : ""}.
        </p>
        {commitError ? <p className="text-sm text-destructive">{commitError}</p> : null}
        <div>
          <Button asChild>
            <Link href={`/employees?company=${companyId}`}>Ver funcionários</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
