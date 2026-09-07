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
  const lines = [csvHeaderLine(columns)];
  for (const row of rows) lines.push(csvBodyLine(columns, row));
  return `${UTF8_BOM}${lines.join("\r\n")}\r\n`;
}

/*
 * The two line builders below exist so a streamed export and a buffered one cannot disagree.
 *
 * A run export streams — its row count is unbounded, and buffering a CSV of every result in a
 * suite is how a download turns into a memory incident. But a second serialiser written for the
 * streaming path would be a second set of quoting and injection rules to keep in step, and the
 * one that got skipped would be the injection guard. So `toCsv` is now defined in terms of these.
 */

/** The header row, without the BOM: a stream emits that once, before anything else. */
export function csvHeaderLine<T>(columns: CsvColumn<T>[]): string {
  return columns.map((column) => quote(column.header)).join(",");
}

/** One row, quoted and de-fanged. No line ending: the caller decides how lines are joined. */
export function csvBodyLine<T>(columns: CsvColumn<T>[], row: T): string {
  return columns
    .map((column) => quote(neutralizeFormula(serializeValue(column.value(row)))))
    .join(",");
}

/** Emitted first by a streamed CSV, for the reason `toCsv` gives. */
export const CSV_PREAMBLE = UTF8_BOM;

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
export function csvResponse(filename: string, body: string | ReadableStream): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}

/**
 * A CSV that is generated while it is being sent.
 *
 * Streaming rather than buffering, and rather than queueing. A run has no upper bound on how many
 * results it holds, so building the whole file in memory first is a download that scales into an
 * incident -- this codebase has the scar: a 191 MiB upload cost 1.1 GB of RSS by materialising a
 * body several times over.
 *
 * A background job was the other candidate and was measured away: the largest run here exports in
 * 11ms, and a queue would add a job row, a stored file, a retention policy, an authorised
 * retrieval route and a notification channel -- while making the reader wait longer and then go
 * and find the result, because a worker cannot hand a file to a browser. Streaming gives bounded
 * memory *and* first bytes immediately, which is what somebody waiting on a download wants.
 *
 * No row cap, and therefore nothing to warn about. The cap existed because the response had to
 * fit in memory.
 */
export function csvStreamResponse<T>(
  filename: string,
  columns: CsvColumn<T>[],
  batches: AsyncIterable<T[]>,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(`${CSV_PREAMBLE}${csvHeaderLine(columns)}\r\n`));
      try {
        for await (const rows of batches) {
          if (rows.length === 0) continue;
          /*
           * One enqueue per batch, not per row. A chunk per row makes the response a few hundred
           * bytes at a time, and the framing overhead dominates a file of a hundred thousand
           * short rows.
           */
          controller.enqueue(
            encoder.encode(`${rows.map((row) => csvBodyLine(columns, row)).join("\r\n")}\r\n`),
          );
        }
        controller.close();
      } catch (error) {
        /*
         * A mid-stream failure cannot become a 500: the status and headers left with the first
         * chunk. Erroring the stream truncates the download, which the browser reports as a
         * failed transfer -- the honest outcome, and better than a file that silently ends early
         * and looks complete.
         */
        controller.error(error);
      }
    },
  });
  return csvResponse(filename, stream);
}
