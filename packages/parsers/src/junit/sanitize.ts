import { Transform } from "node:stream";

/**
 * Strips bytes that are illegal in XML 1.0 but appear constantly in real reports.
 *
 * Frameworks embed captured stdout/stderr straight into `<system-out>`, and that
 * output routinely contains ANSI escape sequences, progress-bar control codes and
 * NUL bytes. A strict XML parser rejects the entire document over one stray 0x1B,
 * which would mean a team's whole nightly run fails to import because a test
 * printed a colour code. Dropping the illegal characters loses nothing a human can
 * read and keeps the import alive.
 *
 * Built with the RegExp constructor rather than a literal so the control-character
 * ranges stay readable as escapes instead of becoming invisible bytes in source.
 * Tab (0x09), LF (0x0A) and CR (0x0D) are legal XML and deliberately preserved.
 */
const ILLEGAL_XML_CHARS = new RegExp(
  "[" +
    "\\x00-\\x08" + // NUL through BACKSPACE
    "\\x0B\\x0C" + //  VT, FF
    "\\x0E-\\x1F" + // SO through US (includes ESC, the ANSI colour prefix)
    "\\uFFFE\\uFFFF" + // non-characters
    "]",
  "g",
);

/** U+FEFF. Written as a code point so it is not an invisible byte in source. */
const BOM = String.fromCharCode(0xfeff);

export interface SanitizeStats {
  bytesRead: number;
  illegalCharsRemoved: number;
}

/**
 * Decodes to UTF-8 and removes illegal characters. Holds back at most one
 * character of state, so memory stays flat regardless of document size.
 */
export function createXmlSanitizer(stats: SanitizeStats): Transform {
  let seenFirstChunk = false;
  /** A surrogate pair can straddle a chunk boundary; carry the lone half over. */
  let pending = "";

  return new Transform({
    readableObjectMode: true,

    transform(chunk: Buffer, _encoding, callback) {
      stats.bytesRead += chunk.length;
      let text = pending + chunk.toString("utf8");
      pending = "";

      const lastCode = text.charCodeAt(text.length - 1);
      if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
        pending = text.slice(-1);
        text = text.slice(0, -1);
      }

      if (!seenFirstChunk && text.length > 0) {
        seenFirstChunk = true;
        if (text.startsWith(BOM)) text = text.slice(BOM.length);
        // Some CI wrappers prepend log noise before the XML declaration.
        const documentStart = text.indexOf("<");
        if (documentStart > 0) text = text.slice(documentStart);
      }

      const cleaned = text.replace(ILLEGAL_XML_CHARS, () => {
        stats.illegalCharsRemoved += 1;
        return "";
      });

      callback(null, cleaned);
    },

    flush(callback) {
      if (pending) {
        callback(null, pending.replace(ILLEGAL_XML_CHARS, ""));
        return;
      }
      callback();
    },
  });
}
