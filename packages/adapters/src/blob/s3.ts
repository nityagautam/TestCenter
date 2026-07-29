import type { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type {
  BlobMetadata,
  BlobStore,
  CreateUploadUrlInput,
  PresignedUpload,
  PutOptions,
} from "@testcenter/core";

/**
 * S3-compatible object store: AWS S3, Cloudflare R2, MinIO, DigitalOcean Spaces.
 *
 * This file and its sibling are the only places an infrastructure SDK may be
 * imported (enforced by ESLint). Everything else depends on the BlobStore port,
 * which is what lets the hosting decision stay open.
 */
export interface S3BlobStoreConfig {
  bucket: string;
  region: string;
  /** Set for MinIO/R2; omit for AWS S3. */
  endpoint?: string | undefined;
  accessKeyId: string;
  secretAccessKey: string;
  /** MinIO needs path-style addressing; AWS prefers virtual-hosted. */
  forcePathStyle?: boolean;
}

const DEFAULT_UPLOAD_EXPIRY_SECONDS = 3600;
const DEFAULT_DOWNLOAD_EXPIRY_SECONDS = 300;

export class S3BlobStore implements BlobStore {
  readonly driver = "s3";
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: S3BlobStoreConfig) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      forcePathStyle: config.forcePathStyle ?? false,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  /**
   * A one-hour default is deliberately generous: CI uploading a 300 MB report over
   * a slow link must not have its URL expire mid-transfer.
   */
  async createUploadUrl(input: CreateUploadUrlInput): Promise<PresignedUpload> {
    const expiresIn = input.expiresInSeconds ?? DEFAULT_UPLOAD_EXPIRY_SECONDS;
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: input.key,
      ...(input.contentType ? { ContentType: input.contentType } : {}),
      ...(input.contentLength ? { ContentLength: input.contentLength } : {}),
    });
    const url = await getSignedUrl(this.client, command, { expiresIn });
    return {
      url,
      method: "PUT",
      key: input.key,
      // Signature covers these headers, so the client must send them verbatim.
      headers: input.contentType ? { "content-type": input.contentType } : {},
      expiresAt: new Date(Date.now() + expiresIn * 1000),
    };
  }

  async createDownloadUrl(key: string, options?: { expiresInSeconds?: number }): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: options?.expiresInSeconds ?? DEFAULT_DOWNLOAD_EXPIRY_SECONDS,
    });
  }

  /** Streamed: the worker parses a 300 MB XML without holding it in memory. */
  async getStream(key: string): Promise<Readable> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!response.Body) throw new Error(`blob ${key} has no body`);
    return response.Body as Readable;
  }

  async put(key: string, body: Buffer | Readable, options?: PutOptions): Promise<{ key: string }> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ...(options?.contentType ? { ContentType: options.contentType } : {}),
        ...(options?.contentLength ? { ContentLength: options.contentLength } : {}),
        ...(options?.checksumSha256
          ? { ChecksumSHA256: Buffer.from(options.checksumSha256, "hex").toString("base64") }
          : {}),
      }),
    );
    return { key };
  }

  async head(key: string): Promise<BlobMetadata | null> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        key,
        bytes: response.ContentLength ?? 0,
        ...(response.ContentType ? { contentType: response.ContentType } : {}),
        ...(response.LastModified ? { lastModified: response.LastModified } : {}),
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async list(prefix: string, options?: { limit?: number }): Promise<BlobMetadata[]> {
    const response = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        MaxKeys: options?.limit ?? 1000,
      }),
    );
    return (response.Contents ?? []).map((object) => ({
      key: object.Key ?? "",
      bytes: object.Size ?? 0,
      ...(object.LastModified ? { lastModified: object.LastModified } : {}),
    }));
  }
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return candidate.name === "NotFound" || candidate.$metadata?.httpStatusCode === 404;
}
