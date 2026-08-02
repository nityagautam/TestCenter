import { createRequire } from "node:module";
import path from "node:path";
import { defineConfig } from "vitest/config";

/*
 * Point `server-only` at its own empty module.
 *
 * `server-only` is a marker package whose default entry throws on import — that is the whole
 * mechanism by which importing a server module into a client bundle fails loudly. Its export
 * map sends the `react-server` condition to an empty file instead, which is what Next
 * resolves when rendering on the server.
 *
 * Vitest is neither, so any test touching a server-only module dies at import. Two tidier
 * fixes do not work here: aliasing the specifier `server-only/empty.js` is refused because
 * the export map exposes only `.`, and adding `react-server` to `resolve.conditions` has no
 * effect because vitest externalises the dependency and Node then resolves it without that
 * condition.
 *
 * Resolving the package's real path and swapping the filename sidesteps both — an absolute
 * path is not subject to the export map. It still uses the package's own empty module rather
 * than a stub of ours, so the marker keeps doing its job in the build, where it matters.
 */
const require = createRequire(import.meta.url);
const serverOnlyEmpty = path.join(path.dirname(require.resolve("server-only")), "empty.js");

export default defineConfig({
  resolve: {
    alias: { "server-only": serverOnlyEmpty },
  },
});
