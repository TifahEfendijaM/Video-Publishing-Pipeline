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
