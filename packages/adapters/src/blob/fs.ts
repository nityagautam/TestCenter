import { createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type {
  BlobMetadata,
  BlobStore,
  CreateUploadUrlInput,
  PresignedUpload,
  PutOptions,
} from "@testcenter/core";

/**
 * Filesystem blob store for local development.
 *
 * Exists because Docker is not a prerequisite for working on this codebase: with
 * BLOB_DRIVER=fs a developer needs only Postgres and Redis. It implements the same
 * presigned-upload contract as S3 — an expiring HMAC-signed URL handled by a route
 * in the web app — so the upload flow exercised locally is the same one that runs
 * in production, rather than a special case that hides bugs until deploy.
 *
 * Not for production: no replication, no lifecycle rules, and it pins state to one
 * machine's disk.
 */
export interface FsBlobStoreConfig {
  /** Directory that holds the blobs, e.g. `.data/blobs`. */
  root: string;
  /** Base URL of the web app, used to build local upload/download URLs. */
  publicBaseUrl: string;
  /** Signing key for local presigned URLs. */
  signingSecret: string;
}

const DEFAULT_UPLOAD_EXPIRY_SECONDS = 3600;
const DEFAULT_DOWNLOAD_EXPIRY_SECONDS = 300;

export class FsBlobStore implements BlobStore {
  readonly driver = "fs";
  /**
   * Absolute, and exposed on purpose: the web app and the worker must agree on this
   * path, and when they do not the symptom is a missing artifact rather than an
   * obvious misconfiguration. /api/health reports it.
   */
  readonly root: string;
  private readonly publicBaseUrl: string;
  private readonly signingSecret: string;

  constructor(config: FsBlobStoreConfig) {
    this.root = resolve(config.root);
    this.publicBaseUrl = config.publicBaseUrl.replace(/\/$/, "");
    this.signingSecret = config.signingSecret;
  }

  /**
   * Keys are attacker-influenced (they contain filenames), so every path is
   * resolved and then checked to still be inside the root. Without this, a key
   * containing `../` would write anywhere the process can reach.
   */
  private pathFor(key: string): string {
    const target = resolve(join(this.root, key));
    if (target !== this.root && !target.startsWith(this.root + sep)) {
      throw new Error(`blob key escapes storage root: ${key}`);
    }
    return target;
  }

  private sign(key: string, expiresAt: number, method: string): string {
    return createHmac("sha256", this.signingSecret)
      .update(`${method}\n${key}\n${expiresAt}`)
      .digest("base64url");
  }

  /** Used by the web app's local blob route before honouring an upload. */
  verifySignature(input: {
    key: string;
    expiresAt: number;
    method: string;
    signature: string;
  }): boolean {
    if (!Number.isFinite(input.expiresAt) || input.expiresAt * 1000 < Date.now()) return false;
    const expected = Buffer.from(this.sign(input.key, input.expiresAt, input.method));
    const provided = Buffer.from(input.signature);
    if (expected.length !== provided.length) return false;
    return timingSafeEqual(expected, provided);
  }

  private buildUrl(key: string, expiresInSeconds: number, method: "PUT" | "GET"): string {
    const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const signature = this.sign(key, expiresAt, method);
    const params = new URLSearchParams({
      key,
      expires: String(expiresAt),
      signature,
      method,
    });
    return `${this.publicBaseUrl}/api/v1/blob?${params.toString()}`;
  }

  async createUploadUrl(input: CreateUploadUrlInput): Promise<PresignedUpload> {
    const expiresIn = input.expiresInSeconds ?? DEFAULT_UPLOAD_EXPIRY_SECONDS;
    return {
      url: this.buildUrl(input.key, expiresIn, "PUT"),
      method: "PUT",
      key: input.key,
      headers: input.contentType ? { "content-type": input.contentType } : {},
      expiresAt: new Date(Date.now() + expiresIn * 1000),
    };
  }

  async createDownloadUrl(key: string, options?: { expiresInSeconds?: number }): Promise<string> {
    return this.buildUrl(key, options?.expiresInSeconds ?? DEFAULT_DOWNLOAD_EXPIRY_SECONDS, "GET");
  }

  async getStream(key: string): Promise<Readable> {
    const path = this.pathFor(key);
    await stat(path); // surface a missing blob as an error, not an empty stream
    return createReadStream(path);
  }

  async put(key: string, body: Buffer | Readable, _options?: PutOptions): Promise<{ key: string }> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    if (Buffer.isBuffer(body)) {
      await writeFile(path, body);
    } else {
      const { createWriteStream } = await import("node:fs");
      await pipeline(body, createWriteStream(path));
    }
    return { key };
  }

  async head(key: string): Promise<BlobMetadata | null> {
    try {
      const stats = await stat(this.pathFor(key));
      return { key, bytes: stats.size, lastModified: stats.mtime };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async list(prefix: string, options?: { limit?: number }): Promise<BlobMetadata[]> {
    const limit = options?.limit ?? 1000;
    const results: BlobMetadata[] = [];

    const walk = async (relativeDir: string): Promise<void> => {
      if (results.length >= limit) return;
      let entries;
      try {
        entries = await readdir(join(this.root, relativeDir), { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (results.length >= limit) return;
        const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await walk(relativePath);
        } else if (relativePath.startsWith(prefix)) {
          const stats = await stat(join(this.root, relativePath));
          results.push({ key: relativePath, bytes: stats.size, lastModified: stats.mtime });
        }
      }
    };

    await walk("");
    return results;
  }
}
