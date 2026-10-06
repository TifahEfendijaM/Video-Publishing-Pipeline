// Upload-Post (https://upload-post.com) for YouTube: its YouTube integration is audited, so uploads can be
// PUBLIC without our own Google audit. Covers both Shorts and regular videos (YouTube decides by format).
// Free plan: 10 uploads / month, no card (over the limit uploads are refused, not billed).
//
// Duplicate safety: we send our own request ID (X-Request-Id + Idempotency-Key). If the upload response is
// lost we poll the status by that ID instead of re-sending, so a lost response never causes a second post.
import { randomUUID } from "node:crypto";
import { openAsBlob, statSync } from "node:fs";
import { HttpStatusError, NetworkError, json, request, sleep } from "../http";
import { AmbiguousOutcome, SafeFailure } from "../../../src/shared/status";
import { summarizeError } from "../../../src/shared/redact";
import type { Gate, IdentityCheck, Outcome, Progress } from "./types";

const BASE = "https://api.upload-post.com";

export class UploadPost {
  constructor(private apiKey: string, private profile: string, private pollMaxMinutes: number) {}
  private h(extra: Record<string, string> = {}) {
    return { authorization: `Apikey ${this.apiKey}`, ...extra };
  }

  async verify(expectedHandle: string): Promise<IdentityCheck> {
    if (!this.profile) return { ok: false, detail: "youtube.uploadPostProfile is not configured" };
    try {
      const r = await json<any>(`${BASE}/api/uploadposts/users`, { label: "upload-post profiles", headers: this.h() });
      const profiles: any[] = r.profiles ?? r.users ?? r.data ?? [];
      const p = profiles.find((x) => (x.username ?? x.user ?? x.name) === this.profile);
      if (!p) return { ok: false, detail: `Upload-Post profile "${this.profile}" not found (have: ${profiles.map((x) => x.username ?? x.user ?? x.name).join(", ") || "none"})` };
      const yt = p.social_accounts?.youtube ?? p.socialAccounts?.youtube;
      if (!yt) return { ok: false, detail: `Upload-Post profile "${this.profile}" has no YouTube account connected` };
      const text = JSON.stringify(yt).toLowerCase();
      const handle = expectedHandle.toLowerCase().replace(/^@/, "");
      const named = text.includes(handle);
      return {
        ok: named,
        detail: named
          ? `Upload-Post profile "${this.profile}" → YouTube ${yt.display_name ?? yt.username ?? yt.handle ?? ""} (matches ${expectedHandle})`
          : `Upload-Post profile "${this.profile}" is connected to YouTube "${yt.display_name ?? yt.username ?? "?"}", which does not look like ${expectedHandle}`,
      };
    } catch (e) {
      return { ok: false, detail: `Upload-Post check failed: ${summarizeError(e, 200)}` };
    }
  }

  async upload(path: string, meta: { title: string; description: string; categoryId: string; madeForKids: boolean }, gate: Gate, progress: Progress): Promise<Outcome> {
    const requestId = randomUUID();
    const form = new FormData();
    form.set("user", this.profile);
    form.append("platform[]", "youtube");
    form.set("title", meta.title);
    form.set("description", meta.description);
    form.set("privacyStatus", "public");
    form.set("categoryId", meta.categoryId);
    form.set("selfDeclaredMadeForKids", String(meta.madeForKids));
    form.set("async_upload", "true");
    form.set("request_id", requestId);
    form.set("video", await openAsBlob(path, { type: "video/mp4" }), "video.mp4");
    const g = await gate();
    if (!g.allowed) return { status: "disabled", detail: `Not sent to Upload-Post: ${g.reason}` };
    await progress("initiated", requestId, `uploading ${(statSync(path).size / 1048576).toFixed(1)} MB to Upload-Post`);
    try {
      const res = await request(`${BASE}/api/upload`, {
        label: "upload-post upload",
        method: "POST",
        headers: this.h({ "X-Request-Id": requestId, "Idempotency-Key": requestId }),
        body: form,
        timeoutMs: 20 * 60_000,
      });
      const text = await res.text();
      if (res.status >= 400 && res.status < 500) {
        throw new SafeFailure(`Upload-Post refused the upload: HTTP ${res.status} ${summarizeError(text, 200)}${res.status === 429 || /limit/i.test(text) ? " (free plan monthly limit reached?)" : ""}`);
      }
      if (!res.ok) throw new HttpStatusError(res.status, text.slice(0, 200), "upload-post upload");
    } catch (e) {
      if (e instanceof SafeFailure) throw e;
      if (e instanceof NetworkError && !e.afterSend) throw new SafeFailure(`Upload-Post request not sent: ${e.message}`);
      // Response lost or server error: look the request up by OUR id rather than re-sending.
      const o = await this.poll(requestId, 0).catch(() => null);
      if (o && o.status !== "processing") return o;
      throw new AmbiguousOutcome(`Upload-Post response lost (${summarizeError(e, 120)}); request ${requestId} may still be published. Run reconcile, or check YouTube Studio, then resolve.`);
    }
    await progress("processing", requestId, "accepted by Upload-Post (not yet proof of publication)");
    return this.poll(requestId, this.pollMaxMinutes);
  }

  /** Read-only status check by request ID (also used by reconcile). */
  async poll(requestId: string, maxMinutes: number): Promise<Outcome> {
    const deadline = Date.now() + maxMinutes * 60_000;
    let last = "unknown";
    do {
      try {
        const r = await json<any>(`${BASE}/api/uploadposts/status?request_id=${encodeURIComponent(requestId)}`, { label: "upload-post status", headers: this.h() });
        last = String(r.status ?? "unknown");
        const results: any[] = Array.isArray(r.results) ? r.results : r.results ? Object.entries(r.results).map(([platform, v]: any) => ({ platform, ...v })) : [];
        const yt = results.find((x) => (x.platform ?? "youtube") === "youtube") ?? null;
        if (yt?.error || yt?.success === false) return { status: "failed", remoteId: requestId, detail: `Upload-Post/YouTube error: ${String(yt.error ?? yt.message ?? "unknown").slice(0, 250)}` };
        if (yt?.url || yt?.video_id) {
          const url = yt.url ?? `https://youtu.be/${yt.video_id}`;
          return { status: "confirmed", remoteId: yt.video_id ?? requestId, url, detail: `published via Upload-Post (${last})` };
        }
        if (/fail|error/i.test(last)) return { status: "failed", remoteId: requestId, detail: `Upload-Post status ${last}` };
      } catch (e) {
        if (e instanceof HttpStatusError && e.status === 404 && maxMinutes === 0) throw e;
      }
      if (maxMinutes > 0) await sleep(30_000);
    } while (Date.now() < deadline);
    return { status: "processing", remoteId: requestId, detail: `Upload-Post status "${last}" after ${maxMinutes} min; run reconcile later.` };
  }
}
