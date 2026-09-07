import { describe, expect, it } from "vitest";
import { csvFilenamePart, csvStreamResponse, toCsv, type CsvColumn } from "./csv.js";

/**
 * The interesting cases here are all about values this product does not control: run names,
 * branches and test names arrive inside XML uploaded by any CI job holding a token. Every
 * assertion below is about what happens when one of them is hostile or merely unusual.
 */
interface Row {
  name: string;
  durationMs: number | null;
  startedAt: Date | null;
  passRate: number | null;
}

const columns: CsvColumn<Row>[] = [
  { header: "name", value: (row) => row.name },
  { header: "duration_ms", value: (row) => row.durationMs },
  { header: "started_at_utc", value: (row) => row.startedAt },
  { header: "pass_rate_percent", value: (row) => row.passRate },
];

const row = (over: Partial<Row> = {}): Row => ({
  name: "checkout",
  durationMs: 2687693,
  startedAt: new Date("2026-08-18T08:08:00.000Z"),
  passRate: 96.4,
  ...over,
});

/** Body without the BOM and trailing break, split into lines, for readable assertions. */
function lines(csv: string): string[] {
  return csv
    .replace(/^\u{FEFF}/u, "")
    .trimEnd()
    .split("\r\n");
}

describe("toCsv", () => {
  it("leads with a UTF-8 BOM", () => {
    // Excel on Windows reads a BOM-less UTF-8 file as the system codepage, so a curly quote
    // or a non-Latin character in a scenario name arrives as mojibake.
    expect(toCsv(columns, [row()]).startsWith("\u{FEFF}")).toBe(true);
  });

  it("uses CRLF line endings and writes a header row", () => {
    const csv = toCsv(columns, [row()]);
    expect(csv).toContain("\r\n");
    expect(lines(csv)[0]).toBe("name,duration_ms,started_at_utc,pass_rate_percent");
  });

  it("keeps durations and rates as numbers, not display strings", () => {
    /*
     * The point of the whole file. `formatDuration(2687693)` is "44m 48s" and
     * `formatPercent(96.4)` is "96.4%", and a column of either cannot be summed or charted.
     * A CSV that reused the display formatters would be a screenshot with commas in it.
     */
    expect(lines(toCsv(columns, [row()]))[1]).toBe(
      "checkout,2687693,2026-08-18T08:08:00.000Z,96.4",
    );
  });

  it("quotes and doubles embedded quotes rather than truncating the cell", () => {
    // Real shape from this codebase's own fixtures: a scenario name carrying a filename.
    const csv = toCsv(columns, [row({ name: 'Negative Brand import with file "a.csv"' })]);
    expect(lines(csv)[1]).toContain('"Negative Brand import with file ""a.csv"""');
  });

  it("quotes cells containing a newline so one row stays one row", () => {
    const csv = toCsv(columns, [row({ name: "assertion failed:\nexpected 200" })]);
    // Three lines, not four: header plus one record whose newline lives inside quotes.
    expect(lines(csv)).toHaveLength(2);
    expect(lines(csv)[1]).toContain('"assertion failed:\nexpected 200"');
  });

  it("neutralises a leading formula character", () => {
    /*
     * CSV injection. A run named `=1+1` is a formula to Excel, and the values here come from
     * uploaded reports. The apostrophe makes the cell text without destroying the original,
     * which is why it beats stripping the character.
     */
    for (const hostile of ["=1+1", "+1", "-1", "@SUM(A1)"]) {
      expect(lines(toCsv(columns, [row({ name: hostile })]))[1]).toContain(`'${hostile}`);
    }
  });

  it("leaves a value with an interior formula character alone", () => {
    // Only the *leading* character triggers evaluation, and quarantining "release-1.0" or
    // "feature/a+b" would corrupt ordinary branch names for no gain.
    expect(lines(toCsv(columns, [row({ name: "release-1.0" })]))[1]).toContain("release-1.0");
  });

  it("writes nulls as empty cells rather than the string null", () => {
    const csv = toCsv(columns, [row({ durationMs: null, startedAt: null, passRate: null })]);
    expect(lines(csv)[1]).toBe("checkout,,,");
  });

  it("writes dates as ISO 8601 in UTC", () => {
    // A datestamp in a spreadsheet has to survive being sorted, subtracted and reimported.
    // The viewer's display zone is the PDF's job; this column states one zone in its header.
    const csv = toCsv(columns, [row({ startedAt: new Date("2026-08-18T02:38:00.000Z") })]);
    expect(lines(csv)[1]).toContain("2026-08-18T02:38:00.000Z");
  });

  it("emits only a header for no rows", () => {
    expect(lines(toCsv(columns, []))).toEqual([
      "name,duration_ms,started_at_utc,pass_rate_percent",
    ]);
  });
});

describe("csvFilenamePart", () => {
  it("collapses anything that is not alphanumeric to single dashes", () => {
    expect(csvFilenamePart("Acme Corp / Web  Checkout")).toBe("acme-corp-web-checkout");
  });

  it("does not leave a leading or trailing dash", () => {
    expect(csvFilenamePart("  —web— ")).toBe("web");
  });

  it("falls back rather than producing an empty filename", () => {
    // A project keyed entirely in a non-Latin script would otherwise yield `testcenter--7d…`.
    expect(csvFilenamePart("・・")).toBe("export");
  });
});

describe("csvStreamResponse", () => {
  interface Row {
    name: string;
    duration: number | null;
  }
  const columns: CsvColumn<Row>[] = [
    { header: "name", value: (row) => row.name },
    { header: "duration", value: (row) => row.duration },
  ];

  /*
   * Bytes, not `response.text()`.
   *
   * The Fetch spec's UTF-8 decode strips a leading byte-order mark, so `text()` silently removes
   * the BOM this serialiser goes out of its way to emit — and a test written against it reports
   * the mark missing when the wire is correct. Excel needs the bytes, so the bytes are what gets
   * asserted.
   */
  async function bytes(batches: Row[][]): Promise<string> {
    const response = csvStreamResponse("x.csv", columns, {
      async *[Symbol.asyncIterator]() {
        for (const batch of batches) yield batch;
      },
    });
    return Buffer.from(await response.arrayBuffer()).toString("utf8");
  }

  it("produces byte-identical output to the buffered serialiser", async () => {
    /*
     * The reason the line builders were factored out at all. A run export streams and a dashboard
     * export buffers; a second serialiser for the streaming path would be a second set of quoting
     * and injection rules to keep in step, and the rule that got forgotten would be the one that
     * matters. This asserts there is only one.
     */
    const rows: Row[] = [
      { name: 'has "quotes", a comma', duration: 12 },
      { name: "=cmd|' /c calc'!A1", duration: null },
      { name: "line\nbreak", duration: 3 },
    ];
    // Split across batches on purpose: batching must not change a single byte of the result.
    expect(await bytes([[rows[0]!], [rows[1]!, rows[2]!]])).toBe(toCsv(columns, rows));
  });

  it("still neutralises a formula in the streamed path", async () => {
    const text = await bytes([[{ name: "=1+1", duration: null }]]);
    expect(text).toContain("'=1+1");
    expect(text).not.toContain("\r\n=1+1");
  });

  it("emits a header and nothing else for an empty export", async () => {
    // A run can legitimately hold no results. The file must still be openable and say so by
    // having a header — a zero-byte download looks like a failure.
    const text = await bytes([[], []]);
    expect(text).toBe(`\u{FEFF}name,duration\r\n`);
  });

  it("sets the download headers, and does not let a cache hold tenant data", async () => {
    const response = csvStreamResponse("run-x.csv", columns, {
      async *[Symbol.asyncIterator]() {
        yield [{ name: "a", duration: 1 }];
      },
    });
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="run-x.csv"');
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
  });

  it("truncates the download rather than pretending it finished", async () => {
    /*
     * Status and headers have already left with the first chunk, so a mid-stream failure cannot
     * become a 500. Erroring the stream makes the browser report a failed transfer, which is
     * honest; silently closing would leave a file that looks complete and is not.
     */
    const response = csvStreamResponse("x.csv", columns, {
      async *[Symbol.asyncIterator]() {
        yield [{ name: "first", duration: 1 }];
        throw new Error("connection lost");
      },
    });
    await expect(response.text()).rejects.toThrow();
  });
});
