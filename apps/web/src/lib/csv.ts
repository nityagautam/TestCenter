/**
 * CSV serialisation for the data exports.
 *
 * Small on purpose, and hand-written rather than pulled from a dependency, because the three
 * things that actually go wrong with a CSV of test data are all decided here and none of them
 * are about commas.
 */

/**
 * As an escape, never the literal character: a BOM pasted into source is invisible, and the
 * next editor to reformat the file would drop it without noticing it had been there.
 */
const UTF8_BOM = "\u{FEFF}";

/** A column is a header plus how to read one value out of a row. */
export interface CsvColumn<T> {
  header: string;
  value: (row: T) => string | number | boolean | Date | null | undefined;
}

/**
 * Excel evaluates a cell that begins with `= + - @`, so a test named `=cmd|…` in a report
 * somebody uploaded becomes a formula in whoever opens the export. That is CSV injection, and
 * this product's cell values are entirely attacker-supplied: run names, branches and test
 * names arrive inside uploaded XML from any CI job with a token.
 *
 * Prefixing an apostrophe is the mitigation that survives a round-trip — the cell reads as
 * text, and unlike stripping the character the original value is still legible. Tab and CR
 * are included because Excel treats a leading one the same way.
 */
function neutralizeFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function serializeValue(value: string | number | boolean | Date | null | undefined): string {
  if (value === null || value === undefined) return "";
  // ISO 8601 in UTC, unambiguous and sortable as text. A display-zone rendering belongs in
  // the PDF; a datestamp in a spreadsheet needs to survive being sorted, subtracted and
  // reimported, which "Aug 18 08:08" does not.
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return value;
}

function quote(cell: string): string {
  // RFC 4180: quote when the cell contains a delimiter, a quote or a newline; escape an
  // embedded quote by doubling it. Failure messages and test names contain all three.
  return /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
}

/**
 * Rows to a CSV body.
 *
 * CRLF line endings per RFC 4180, and a UTF-8 byte-order mark. The BOM is not decoration:
 * Excel on Windows reads a BOM-less UTF-8 file as the system codepage, so a scenario name
 * containing a curly quote or a non-Latin character — this codebase's own fixtures have both
 * — arrives as mojibake and the reader blames the product rather than their spreadsheet.
 */
export function toCsv<T>(columns: CsvColumn<T>[], rows: Iterable<T>): string {
  const lines = [columns.map((column) => quote(column.header)).join(",")];
  for (const row of rows) {
    lines.push(
      columns
        .map((column) => quote(neutralizeFormula(serializeValue(column.value(row)))))
        .join(","),
    );
  }
  return `${UTF8_BOM}${lines.join("\r\n")}\r\n`;
}

/** Trims a label down to something safe to put in a `filename=` parameter. */
export function csvFilenamePart(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "export"
  );
}

/**
 * A CSV download response.
 *
 * `Content-Disposition` carries the filename because the URL cannot: the route path is
 * `…/export/dashboard/csv`, and without this header the browser saves a file called `csv`.
 *
 * `no-store` because these responses are tenant data resolved from a session cookie. A
 * shared cache that keyed on the URL alone would serve one organisation's runs to the next
 * viewer of the same path.
 */
export function csvResponse(filename: string, body: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}
