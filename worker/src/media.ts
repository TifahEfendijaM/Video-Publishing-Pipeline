// Temporary video hosting on Workers KV (free plan: 25 MiB per value, 1 GB total, 1,000 writes/day;
// over-limit requests fail instead of being billed). Only providers that must FETCH a URL use it
// (Instagram, Buffer). Keys are 256-bit random, values expire after a few hours and are deleted after use.
// Note: KV is eventually consistent across locations (up to ~60 s), so the runner waits before
// handing a fresh URL to a provider.

export interface MediaKV {
  put(key: string, value: ReadableStream | ArrayBuffer, opts?: { expirationTtl?: number; metadata?: unknown }): Promise<void>;
  getWithMetadata<M = unknown>(key: string, type: "arrayBuffer"): Promise<{ value: ArrayBuffer | null; metadata: M | null }>;
  delete(key: string): Promise<void>;
}

export const MAX_MEDIA_BYTES = 24 * 1024 * 1024; // stay under the 25 MiB KV value limit
const KEY_RE = /^[a-f0-9]{64}$/;

function randomKey(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Authenticated upload: raw video body. Returns the unguessable public URL. */
export async function putMedia(kv: MediaKV, req: Request, origin: string, ttlSec: number): Promise<Response> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (!len || len > MAX_MEDIA_BYTES) {
    return Response.json({ error: `video must be 1 byte – ${MAX_MEDIA_BYTES} bytes for temporary hosting (got ${len})` }, { status: 413 });
  }
  const body = await req.arrayBuffer();
  if (body.byteLength !== len) return Response.json({ error: "incomplete body" }, { status: 400 });
  const key = randomKey();
  const ttl = Math.min(Math.max(ttlSec, 600), 86400);
  await kv.put(key, body, { expirationTtl: ttl, metadata: { size: body.byteLength, type: req.headers.get("content-type") ?? "video/mp4" } });
  return Response.json({ key, url: `${origin}/media/${key}.mp4`, expiresInSec: ttl });
}

export async function deleteMedia(kv: MediaKV, key: string): Promise<Response> {
  if (!KEY_RE.test(key)) return Response.json({ error: "bad key" }, { status: 400 });
  await kv.delete(key);
  return Response.json({ ok: true });
}

/** Public, unauthenticated read by key (GET/HEAD, single byte-range supported). */
export async function serveMedia(kv: MediaKV, req: Request, key: string): Promise<Response> {
  if (!KEY_RE.test(key)) return new Response("not found", { status: 404 });
  const { value, metadata } = await kv.getWithMetadata<{ size: number; type: string }>(key, "arrayBuffer");
  if (!value) return new Response("not found", { status: 404 });
  const size = value.byteLength;
  const base: Record<string, string> = {
    "content-type": metadata?.type ?? "video/mp4",
    "accept-ranges": "bytes",
    "cache-control": "private, no-store",
    "x-robots-tag": "noindex",
  };
  const range = req.headers.get("range");
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (m && (m[1] !== "" || m[2] !== "")) {
    let start = m[1] === "" ? size - Number(m[2]) : Number(m[1]);
    let end = m[1] === "" || m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
    if (start < 0) start = 0;
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { ...base, "content-range": `bytes */${size}` } });
    const chunk = value.slice(start, end + 1);
    return new Response(req.method === "HEAD" ? null : chunk, {
      status: 206,
      headers: { ...base, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(chunk.byteLength) },
    });
  }
  return new Response(req.method === "HEAD" ? null : value, { status: 200, headers: { ...base, "content-length": String(size) } });
}
