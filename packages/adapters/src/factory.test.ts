import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLocalBlobRoot } from "./factory.js";

describe("resolveLocalBlobRoot", () => {
  it("leaves an absolute path untouched", () => {
    expect(resolveLocalBlobRoot("/var/lib/testcenter/blobs")).toBe("/var/lib/testcenter/blobs");
  });

  it("resolves a relative path to the same directory from any app's cwd", async () => {
    // This is the bug this function exists for: the web app runs from apps/web and
    // the worker from the repo root, so a relative BLOB_LOCAL_DIR used to resolve to
    // two different folders. The API would upload an artifact the worker could not
    // find, and ingest failed with ENOENT on a file that had definitely arrived.
    const root = await mkdtemp(join(tmpdir(), "testcenter-ws-"));
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - 'apps/*'\n");
    await mkdir(join(root, "apps", "web"), { recursive: true });

    const fromRoot = resolveLocalBlobRoot(".data/blobs", root);
    const fromWebApp = resolveLocalBlobRoot(".data/blobs", join(root, "apps", "web"));

    expect(fromWebApp).toBe(fromRoot);
    expect(fromRoot).toBe(join(root, ".data/blobs"));
  });

  it("falls back to cwd when no workspace marker exists", async () => {
    // A deployed image ships one app and no workspace file; cwd is then the only
    // sensible anchor and is stable within that process.
    const isolated = await mkdtemp(join(tmpdir(), "testcenter-solo-"));
    expect(resolveLocalBlobRoot("blobs", isolated)).toBe(join(isolated, "blobs"));
  });
});
