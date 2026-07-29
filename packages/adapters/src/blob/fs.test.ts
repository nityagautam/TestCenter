import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsBlobStore } from "./fs.js";

describe("FsBlobStore", () => {
  let root: string;
  let store: FsBlobStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "testcenter-blob-"));
    store = new FsBlobStore({
      root,
      publicBaseUrl: "http://localhost:3000",
      signingSecret: "test-secret",
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("round-trips a blob", async () => {
    await store.put("orgs/a/projects/b/report.xml", Buffer.from("<testsuite/>"));
    const meta = await store.head("orgs/a/projects/b/report.xml");
    expect(meta?.bytes).toBe(12);

    const stream = await store.getStream("orgs/a/projects/b/report.xml");
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe("<testsuite/>");
  });

  it("returns null rather than throwing for a missing blob", async () => {
    expect(await store.head("nope")).toBeNull();
  });

  it("refuses keys that escape the storage root", async () => {
    // Keys embed user-supplied filenames, so traversal is a real input, not a
    // theoretical one.
    await expect(store.put("../../escaped.txt", Buffer.from("x"))).rejects.toThrow(
      /escapes storage root/,
    );
    await expect(store.head("orgs/../../../etc/passwd")).resolves.toBeNull();
  });

  it("issues a signed upload URL that validates", async () => {
    const upload = await store.createUploadUrl({
      key: "orgs/a/report.xml",
      contentType: "application/xml",
    });
    expect(upload.method).toBe("PUT");
    expect(upload.headers["content-type"]).toBe("application/xml");

    const url = new URL(upload.url);
    const verified = store.verifySignature({
      key: url.searchParams.get("key") ?? "",
      expiresAt: Number(url.searchParams.get("expires")),
      method: "PUT",
      signature: url.searchParams.get("signature") ?? "",
    });
    expect(verified).toBe(true);
  });

  it("rejects a tampered key", async () => {
    const upload = await store.createUploadUrl({ key: "orgs/a/report.xml" });
    const url = new URL(upload.url);
    expect(
      store.verifySignature({
        key: "orgs/b/other.xml",
        expiresAt: Number(url.searchParams.get("expires")),
        method: "PUT",
        signature: url.searchParams.get("signature") ?? "",
      }),
    ).toBe(false);
  });

  it("rejects an expired signature", async () => {
    const expiresAt = Math.floor(Date.now() / 1000) - 10;
    expect(
      store.verifySignature({ key: "k", expiresAt, method: "PUT", signature: "whatever" }),
    ).toBe(false);
  });

  it("rejects a signature issued for a different method", async () => {
    const upload = await store.createUploadUrl({ key: "orgs/a/report.xml" });
    const url = new URL(upload.url);
    expect(
      store.verifySignature({
        key: url.searchParams.get("key") ?? "",
        expiresAt: Number(url.searchParams.get("expires")),
        method: "GET",
        signature: url.searchParams.get("signature") ?? "",
      }),
    ).toBe(false);
  });

  it("lists by prefix", async () => {
    await store.put("orgs/a/one.xml", Buffer.from("1"));
    await store.put("orgs/a/two.xml", Buffer.from("2"));
    await store.put("orgs/b/three.xml", Buffer.from("3"));

    const listed = await store.list("orgs/a/");
    expect(listed.map((blob) => blob.key).sort()).toEqual(["orgs/a/one.xml", "orgs/a/two.xml"]);
  });

  it("deletes idempotently", async () => {
    await store.put("orgs/a/one.xml", Buffer.from("1"));
    await store.delete("orgs/a/one.xml");
    await expect(store.delete("orgs/a/one.xml")).resolves.toBeUndefined();
  });
});
