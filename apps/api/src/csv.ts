import { ProductError } from "./product";

export class CsvError extends ProductError {
  constructor(
    code: string,
    public line: number,
    public column: number,
  ) {
    super(code, 400);
  }
}
export type CsvRecord = { line: number; cells: string[] };

// Bounded UTF-8 CSV with comma separators, doubled quotes, BOM and CRLF/LF.
// Never evaluate cells, guess an encoding, or silently recover malformed quotes.
export function parseCsv(text: string): CsvRecord[] {
  if (new TextEncoder().encode(text).byteLength > 1_000_000)
    throw new ProductError("CSV_TOO_LARGE", 400);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/.test(text))
    throw new ProductError("CSV_INVALID_ENCODING", 400);
  text = text.replace(/^\ufeff/, "");
  const records: CsvRecord[] = [];
  let row: string[] = [],
    cell = "",
    quoted = false,
    closed = false;
  let line = 1,
    recordLine = 1;
  const field = () => {
    row.push(cell);
    cell = "";
    closed = false;
    if (row.length > 64)
      throw new CsvError("CSV_TOO_MANY_COLUMNS", recordLine, row.length);
  };
  const record = () => {
    field();
    if (row.length !== 1 || row[0] !== "")
      records.push({ line: recordLine, cells: row });
    row = [];
    if (records.length > 10_001)
      throw new CsvError("CSV_TOO_MANY_ROWS", recordLine, 1);
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else if (char === "\r" || char === "\n") {
        if (char === "\r" && text[i + 1] === "\n") i++;
        cell += "\n";
        line++;
      } else cell += char;
    } else if (char === ",") field();
    else if (char === "\r" || char === "\n") {
      record();
      if (char === "\r" && text[i + 1] === "\n") i++;
      line++;
      recordLine = line;
    } else if (char === '"' && cell === "" && !closed) quoted = true;
    else {
      if (closed || char === '"')
        throw new CsvError("CSV_INVALID_QUOTES", line, row.length + 1);
      cell += char;
    }
    if (cell.length > 4096)
      throw new CsvError("CSV_CELL_TOO_LONG", line, row.length + 1);
  }
  if (quoted)
    throw new CsvError("CSV_INVALID_QUOTES", recordLine, row.length + 1);
  if (cell || row.length || closed) record();
  return records;
}
