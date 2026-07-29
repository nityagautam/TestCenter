import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { NextResponse } from "next/server";
import { FsBlobStore } from "@testcenter/adapters";
import { getServices } from "@/lib/services";

/**
 * Local presigned-upload endpoint for BLOB_DRIVER=fs.
 *
 * Only active with the filesystem driver, which exists so this repo can be worked
 * on without Docker. It deliberately implements the same signed-URL contract as S3
 * so the upload path exercised in development is the production path, not a
 * special case that hides bugs until deploy. With BLOB_DRIVER=s3 the browser and
 * CI talk to object storage directly and never reach this route.
 */
export const dynamic = "force-dynamic";

function resolveStore(): FsBlobStore | null {
  const { blobStore } = getServices();
  return blobStore instanceof FsBlobStore ? blobStore : null;
}

interface SignedRequest {
  key: string;
  expiresAt: number;
  signature: string;
}

function readSignedParams(request: Request): SignedRequest | null {
  const params = new URL(request.url).searchParams;
  const key = params.get("key");
  const expires = params.get("expires");
  const signature = params.get("signature");
  if (!key || !expires || !signature) return null;
  return { key, expiresAt: Number(expires), signature };
}

export async function PUT(request: Request): Promise<NextResponse | Response> {
  const store = resolveStore();
  if (!store) {
    return NextResponse.json(
      { error: "local blob endpoint is only available with BLOB_DRIVER=fs" },
      { status: 404 },
    );
  }

  const signed = readSignedParams(request);
  if (!signed || !store.verifySignature({ ...signed, method: "PUT" })) {
    return NextResponse.json({ error: "invalid or expired upload signature" }, { status: 403 });
  }
  if (!request.body) {
    return NextResponse.json({ error: "request body is required" }, { status: 400 });
  }

  // Streamed rather than buffered: a real report can be hundreds of megabytes and
  // must never be held in memory by the API process.
  await store.put(signed.key, Readable.fromWeb(request.body as NodeWebReadableStream));
  const meta = await store.head(signed.key);

  return NextResponse.json({ key: signed.key, bytes: meta?.bytes ?? 0 }, { status: 200 });
}

export async function GET(request: Request): Promise<NextResponse | Response> {
  const store = resolveStore();
  if (!store) {
    return NextResponse.json(
      { error: "local blob endpoint is only available with BLOB_DRIVER=fs" },
      { status: 404 },
    );
  }

  const signed = readSignedParams(request);
  if (!signed || !store.verifySignature({ ...signed, method: "GET" })) {
    return NextResponse.json({ error: "invalid or expired download signature" }, { status: 403 });
  }

  const meta = await store.head(signed.key);
  if (!meta) return NextResponse.json({ error: "not found" }, { status: 404 });

  const stream = await store.getStream(signed.key);
  return new Response(Readable.toWeb(stream) as unknown as BodyInit, {
    headers: {
      "content-type": meta.contentType ?? "application/octet-stream",
      "content-length": String(meta.bytes),
      "cache-control": "private, max-age=300",
    },
  });
}
