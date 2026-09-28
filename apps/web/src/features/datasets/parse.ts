// Turning pasted or uploaded test data into columns and rows. CSV follows RFC 4180 (quoted fields,
// doubled quotes, newlines inside quotes); TSV is what spreadsheets put on the clipboard.

export interface ParsedTable {
  columns: string[];
  rows: Record<string, string>[];
}

/** Splits delimited text into records, honouring quotes. */
export function parseDelimited(text: string, delimiter = detectDelimiter(text)): string[][] {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) {
      record.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || record.length) records.push([...record, field]);
  return records.filter((r) => r.some((v) => v.trim() !== ''));
}

/** Tab when the first line has tabs (spreadsheet paste), semicolon for European CSV, else comma. */
export function detectDelimiter(text: string): string {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  if (first.includes('\t')) return '\t';
  return (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ';' : ',';
}

/** First record is the header; blank or repeated header names get a unique fallback. */
export function tableFromRecords(records: string[][]): ParsedTable {
  const [header = [], ...body] = records;
  const seen = new Set<string>();
  const columns = header.map((raw, i) => {
    let name = raw.trim() || `column ${i + 1}`;
    for (let n = 2; seen.has(name.toLowerCase()); n++) name = `${raw.trim() || 'column'} ${n}`;
    seen.add(name.toLowerCase());
    return name;
  });
  return {
    columns,
    rows: body.map((r) => Object.fromEntries(columns.map((c, i) => [c, (r[i] ?? '').trim()]))),
  };
}

/** An array of flat objects, e.g. `[{"amount": 100, "vpa": "a@upi"}]`; nested values become JSON text. */
export function tableFromJson(text: string): ParsedTable {
  const data: unknown = JSON.parse(text);
  const list = Array.isArray(data) ? data : [data];
  const columns = [...new Set(list.flatMap((o) => (o && typeof o === 'object' ? Object.keys(o) : [])))];
  if (!columns.length) throw new Error('The JSON needs to be an array of objects, such as [{"amount": "100"}].');
  const str = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  return { columns, rows: list.map((o) => Object.fromEntries(columns.map((c) => [c, str((o as Record<string, unknown>)?.[c])]))) };
}

export function parseTable(fileName: string, text: string): ParsedTable {
  if (/\.json$/i.test(fileName) || /^\s*[[{]/.test(text)) return tableFromJson(text);
  return tableFromRecords(parseDelimited(text));
}

/** CSV for export: quotes only where needed. */
export function toCsv({ columns, rows }: ParsedTable): string {
  const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [columns.map(cell).join(','), ...rows.map((r) => columns.map((c) => cell(r[c] ?? '')).join(','))].join('\n');
}
