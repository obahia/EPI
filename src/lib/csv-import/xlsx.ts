/**
 * XLSX ingestion for the import wizard (spec §18).
 *
 * Parsing happens CLIENT-SIDE, exactly like the existing CSV path: the spreadsheet never
 * reaches our servers and is never stored, so there is no upload endpoint and no file at
 * rest to protect. That is a deliberate continuation of the current architecture, not an
 * omission.
 *
 * An .xlsx file is a ZIP archive, so it is a zip-bomb vector. The guards below run BEFORE
 * the file is handed to the parser -- checking afterwards is checking after the damage.
 */

export const XLSX_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const XLSX_MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
export const XLSX_MAX_COMPRESSION_RATIO = 100;
export const XLSX_MAX_ENTRIES = 512;
export const XLSX_MAX_ROWS = 50_000;

export type XlsxRejection =
  | "not_a_zip"
  | "file_too_large"
  | "too_many_entries"
  | "uncompressed_too_large"
  | "compression_ratio"
  | "corrupt_archive"
  | "too_many_rows"
  | "empty";

export class XlsxRejectedError extends Error {
  constructor(readonly reason: XlsxRejection) {
    super(`xlsx rejected: ${reason}`);
    this.name = "XlsxRejectedError";
  }
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

/**
 * Sums the declared uncompressed sizes from the ZIP central directory.
 *
 * We read the directory ourselves rather than trusting the parser, because by the time a
 * parser reports a size it has already allocated it. The declared sizes are attacker
 * controlled, but that cuts the right way here: a bomb has to declare its expansion to be
 * unpackable at all, so a liar either fails this check or fails to expand.
 */
function totalUncompressedSize(bytes: Uint8Array): { total: number; entries: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // The EOCD record is at the end, after a comment of up to 64 KiB. Scan backwards.
  let eocd = -1;
  const scanFloor = Math.max(0, bytes.length - 65_557);
  for (let i = bytes.length - 22; i >= scanFloor; i -= 1) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new XlsxRejectedError("corrupt_archive");

  const entries = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  if (entries > XLSX_MAX_ENTRIES) throw new XlsxRejectedError("too_many_entries");

  let total = 0;
  for (let n = 0; n < entries; n += 1) {
    if (offset + 46 > bytes.length) throw new XlsxRejectedError("corrupt_archive");
    if (view.getUint32(offset, true) !== CENTRAL_SIGNATURE) {
      throw new XlsxRejectedError("corrupt_archive");
    }
    total += view.getUint32(offset + 24, true); // uncompressed size
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    offset += 46 + nameLen + extraLen + commentLen;

    // Checked inside the loop, not after: a directory claiming petabytes should be refused
    // on the entry that crosses the line, not after summing every entry.
    if (total > XLSX_MAX_UNCOMPRESSED_BYTES) {
      throw new XlsxRejectedError("uncompressed_too_large");
    }
  }

  return { total, entries };
}

/** Throws XlsxRejectedError if the file must not be parsed. Call before anything else. */
export function assertSafeXlsx(bytes: Uint8Array): void {
  if (bytes.length > XLSX_MAX_FILE_BYTES) throw new XlsxRejectedError("file_too_large");
  if (bytes.length < 22) throw new XlsxRejectedError("not_a_zip");
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) throw new XlsxRejectedError("not_a_zip");

  const { total } = totalUncompressedSize(bytes);
  if (total > XLSX_MAX_UNCOMPRESSED_BYTES) throw new XlsxRejectedError("uncompressed_too_large");
  if (bytes.length > 0 && total / bytes.length > XLSX_MAX_COMPRESSION_RATIO) {
    throw new XlsxRejectedError("compression_ratio");
  }
}

/**
 * Formula cells: read-excel-file returns the cached VALUE stored in the sheet, never the
 * formula text, and evaluates nothing. A cell with a formula and no cached value comes back
 * empty, which becomes an ordinary row error rather than an execution.
 *
 * Everything is coerced to string here so the downstream validators (validate-rows.ts) see
 * exactly the same shape they already see for CSV -- one parser, one validation path.
 */
export async function readXlsxRows(file: File): Promise<string[][]> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  assertSafeXlsx(buffer);

  // The /browser subpath specifically: the package exposes no root export, and this is the
  // build that takes a File. Dynamic import so the parser is only downloaded by someone who
  // actually uploads a spreadsheet -- the CSV path stays as light as it is today.
  //
  // readSheet(file, 1) reads ONLY the first sheet. A workbook with a data sheet plus lookup
  // or pivot sheets is ordinary, and concatenating them would import garbage silently.
  const { readSheet } = await import("read-excel-file/browser");
  const rows = await readSheet(file, 1);

  if (rows.length === 0) throw new XlsxRejectedError("empty");
  if (rows.length > XLSX_MAX_ROWS) throw new XlsxRejectedError("too_many_rows");

  return rows.map((row) =>
    row.map((cell): string => {
      if (cell === null || cell === undefined) return "";
      if (cell instanceof Date) {
        // Dates are not among §18's mappable fields (Nome, CPF, Matrícula, Cargo, Unidade,
        // Telefone, Email), so ISO is only ever a legible fallback for a column mapped
        // somewhere it does not belong.
        return cell.toISOString().slice(0, 10);
      }
      return String(cell);
    }),
  );
}

/**
 * Neutralises spreadsheet formula injection in text WE write back out -- specifically the
 * errors CSV, which is the real vector: the user opens our export in Excel, and a cell that
 * came from their own upload starting with "=" would execute there.
 */
export function neutralizeFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}
