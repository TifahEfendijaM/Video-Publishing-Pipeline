// Temporary, private-by-default video hosting on Cloudflare R2. Objects get random names (no filenames),
// are reachable only through short-lived presigned GET URLs, and are deleted after use (plus a bucket
// lifecycle rule as a backstop). Used only for providers that must fetch media from a URL (Buffer, Instagram).
import { AwsClient } from "aws4fetch";
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { registerSecret } from "../../src/shared/redact";

export interface HostedObject {
  key: string;
  url: string; // presigned, secret — never print
}

export class R2Hosting {
  private client: AwsClient;
  private base: string;
  constructor(accountId: string, private bucket: string, accessKeyId: string, secretAccessKey: string, private ttlSec: number) {
    this.client = new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region: "auto" });
    this.base = `https://${accountId}.r2.cloudflarestorage.com/${bucket}`;
  }

  async put(path: string, contentType = "video/mp4"): Promise<HostedObject> {
    const size = statSync(path).size;
    if (size > 4.9 * 1024 ** 3) throw new Error("file too large for single-part temporary upload");
    const key = `tmp/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.mp4`;
    const res = await this.client.fetch(`${this.base}/${key}`, {
      method: "PUT",
      body: readFileSync(path),
      headers: { "content-type": contentType, "content-length": String(size) },
    });
    if (!res.ok) throw new Error(`temporary hosting upload failed: HTTP ${res.status}`);
    const signed = await this.client.sign(`${this.base}/${key}?X-Amz-Expires=${this.ttlSec}`, { method: "GET", aws: { signQuery: true } });
    registerSecret(signed.url);
    return { key, url: signed.url };
  }

  async remove(key: string): Promise<void> {
    await this.client.fetch(`${this.base}/${key}`, { method: "DELETE" });
  }

  async selfTest(): Promise<string> {
    const key = `tmp/verify-${randomUUID()}.txt`;
    const put = await this.client.fetch(`${this.base}/${key}`, { method: "PUT", body: "ok" });
    if (!put.ok) return `write failed (HTTP ${put.status})`;
    const signed = await this.client.sign(`${this.base}/${key}?X-Amz-Expires=60`, { method: "GET", aws: { signQuery: true } });
    const get = await fetch(signed.url);
    const anon = await fetch(`${this.base}/${key}`);
    await this.remove(key);
    return `write ok, presigned read ${get.ok ? "ok" : `failed (${get.status})`}, anonymous read ${anon.ok ? "ALLOWED (bucket is public!)" : "blocked (good)"}`;
  }
}

/**
 * Default temporary hosting: the scheduler Worker's free Workers KV namespace (no payment method needed;
 * over-limit requests fail rather than being billed). Max 24 MB per file; larger files fall back to R2
 * only if it is configured.
 */
export class KvHosting {
  static readonly MAX_BYTES = 24 * 1024 * 1024;
  constructor(private baseUrl: string, private token: string, private propagationWaitMs = 60_000) {}

  async put(path: string): Promise<HostedObject> {
    const size = statSync(path).size;
    if (size > KvHosting.MAX_BYTES) throw new Error(`file is ${(size / 1048576).toFixed(1)} MB; free KV hosting allows ${KvHosting.MAX_BYTES / 1048576} MB`);
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/api/media`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "video/mp4", "content-length": String(size) },
      body: readFileSync(path),
    });
    if (!res.ok) throw new Error(`temporary hosting upload failed: HTTP ${res.status}`);
    const j = (await res.json()) as { key: string; url: string };
    registerSecret(j.url);
    // KV is eventually consistent across Cloudflare locations; give the value time to propagate
    // before a provider in another region fetches it.
    await new Promise((r) => setTimeout(r, this.propagationWaitMs));
    return { key: j.key, url: j.url };
  }

  async remove(key: string): Promise<void> {
    await fetch(`${this.baseUrl.replace(/\/$/, "")}/api/media/${key}`, { method: "DELETE", headers: { authorization: `Bearer ${this.token}` } });
  }

  async selfTest(): Promise<string> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/api/media`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "video/mp4", "content-length": "2" },
      body: "ok",
    });
    if (!res.ok) return `write failed (HTTP ${res.status})`;
    const j = (await res.json()) as { key: string; url: string };
    const get = await fetch(j.url);
    const guess = await fetch(j.url.replace(/[a-f0-9]{64}/, "0".repeat(64)));
    await this.remove(j.key);
    return `write ok, read by secret URL ${get.ok ? "ok" : `failed (${get.status})`}, guessed URL ${guess.ok ? "SERVED (problem!)" : "rejected (good)"}`;
  }
}
