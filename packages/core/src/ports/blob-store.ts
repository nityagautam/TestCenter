import type { Readable } from "node:stream";

/**
 * Object storage port.
 *
 * Raw uploaded reports are the system's source of truth — the database is a
 * derived projection that we re-compute whenever a parser improves. That makes
 * this interface load-bearing, and it is why no caller may import an S3 SDK
 * directly (enforced by an ESLint rule): the hosting target is still open, and
 * swapping S3 for R2, MinIO, or a local directory must remain a one-file change.
 */
export interface BlobStore {
  readonly driver: string;

  /**
   * Presigned upload URL so large reports go client/CI → storage directly,
   * never through our API. A 300 MB JUnit XML must not touch an API process.
   */
  createUploadUrl(input: CreateUploadUrlInput): Promise<PresignedUpload>;

  /** Presigned download URL for attachments rendered in the browser. */
  createDownloadUrl(key: string, options?: { expiresInSeconds?: number }): Promise<string>;

  /** Streamed so the worker can parse without buffering the whole artifact. */
  getStream(key: string): Promise<Readable>;

  put(key: string, body: Buffer | Readable, options?: PutOptions): Promise<{ key: string }>;

  head(key: string): Promise<BlobMetadata | null>;

  delete(key: string): Promise<void>;

  /** Used by retention jobs to expire artifacts past their project's window. */
  list(prefix: string, options?: { limit?: number }): Promise<BlobMetadata[]>;
}

export interface CreateUploadUrlInput {
  key: string;
  contentType?: string;
  contentLength?: number;
  expiresInSeconds?: number;
}

export interface PresignedUpload {
  /** PUT the bytes here. */
  url: string;
  /** Headers that must accompany the PUT for the signature to validate. */
  headers: Record<string, string>;
  key: string;
  expiresAt: Date;
  method: "PUT";
}

export interface PutOptions {
  contentType?: string;
  contentLength?: number;
  /** Hex sha256 of the payload, stored for integrity verification on re-parse. */
  checksumSha256?: string;
}

export interface BlobMetadata {
  key: string;
  bytes: number;
  contentType?: string;
  lastModified?: Date;
  checksumSha256?: string;
}

/**
 * Deterministic key layout.
 *
 * Prefixed by org and project so retention and per-tenant deletion are a prefix
 * scan, and date-partitioned so lifecycle rules can expire whole days at once.
 */
export function artifactKey(input: {
  orgId: string;
  projectId: string;
  runId: string;
  artifactId: string;
  filename: string;
}): string {
  const safeName = input.filename.replace(/[^\w.-]/g, "_").slice(-128);
  return `orgs/${input.orgId}/projects/${input.projectId}/runs/${input.runId}/artifacts/${input.artifactId}/${safeName}`;
}

export function attachmentKey(input: {
  orgId: string;
  projectId: string;
  runId: string;
  attachmentId: string;
  filename: string;
}): string {
  const safeName = input.filename.replace(/[^\w.-]/g, "_").slice(-128);
  return `orgs/${input.orgId}/projects/${input.projectId}/runs/${input.runId}/attachments/${input.attachmentId}/${safeName}`;
}
