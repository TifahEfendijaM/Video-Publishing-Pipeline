// Meta Graph API: Instagram Reels/Stories and Facebook Page Reels/Stories/videos.
// One Page access token (from a Business system user, non-expiring) covers the Page and its linked Instagram account.
import { openSync, readSync, closeSync, statSync, readFileSync } from "node:fs";
import { HttpStatusError, NetworkError, json, request, sleep } from "../http";
import { AmbiguousOutcome, SafeFailure } from "../../../src/shared/status";
import { summarizeError } from "../../../src/shared/redact";
import type { Gate, IdentityCheck, Outcome, Progress } from "./types";

export const META_REQUIRED_PERMISSIONS = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "instagram_basic",
  "instagram_content_publish",
  "business_management",
];

function graphError(e: unknown): string {
  if (e instanceof HttpStatusError) {
    try {
      const j = JSON.parse(e.bodySummary);
      return `HTTP ${e.status} ${j.error?.type ?? ""} ${j.error?.code ?? ""}/${j.error?.error_subcode ?? ""}: ${j.error?.message ?? ""}`.slice(0, 300);
    } catch {
      /* fall through */
    }
  }
  return summarizeError(e, 300);
}

/** 4xx: the request was refused. 5xx / network after send: unknown. */
function classifySubmit(e: unknown, what: string): never {
  if (e instanceof HttpStatusError && e.status >= 400 && e.status < 500) throw new SafeFailure(`${what} refused: ${graphError(e)}`);
  if (e instanceof NetworkError && !e.afterSend) throw new SafeFailure(`${what} not sent: ${e.message}`);
  throw new AmbiguousOutcome(`${what}: response lost or server error (${graphError(e)}); the post may or may not exist — check manually, then resolve.`);
}

export class Meta {
  constructor(private token: string, private version: string, private pollMaxMinutes: number) {}

  private url(path: string) {
    return `https://graph.facebook.com/${this.version}/${path}`;
  }
  private h(extra: Record<string, string> = {}) {
    return { authorization: `Bearer ${this.token}`, ...extra };
  }
  private get<T = any>(path: string, label: string) {
    return json<T>(this.url(path), { label, headers: this.h(), timeoutMs: 60_000 });
  }
  private post<T = any>(path: string, params: Record<string, string>, label: string, base = "https://graph.facebook.com") {
    return json<T>(`${base}/${this.version}/${path}`, {
      label,
      method: "POST",
      headers: this.h({ "content-type": "application/x-www-form-urlencoded" }),
      body: new URLSearchParams(params),
      timeoutMs: 120_000,
    });
  }

  // ------------------------------------------------------------------ verification

  async verifyFacebook(expectedPageId: string, expectedName: string): Promise<IdentityCheck> {
    if (!expectedPageId) return { ok: false, detail: "expectedPageId is not configured" };
    try {
      const me = await this.get<{ id: string; name: string }>("me?fields=id,name", "meta me");
      if (me.id !== expectedPageId) return { ok: false, detail: `token belongs to ${me.name} (${me.id}), expected Page ${expectedPageId}` };
      return { ok: true, detail: `Facebook Page "${me.name}" (${me.id})${me.name !== expectedName ? ` — note: name differs from expected "${expectedName}"` : ""}` };
    } catch (e) {
      return { ok: false, detail: `Page check failed: ${graphError(e)}` };
    }
  }

  async verifyInstagram(pageId: string, expectedUserId: string, expectedUsername: string): Promise<IdentityCheck> {
    if (!expectedUserId) return { ok: false, detail: "expectedUserId is not configured" };
    try {
      const p = await this.get<any>(`${pageId}?fields=instagram_business_account{id,username}`, "meta page ig");
      const ig = p.instagram_business_account;
      if (!ig) return { ok: false, detail: "Page has no linked Instagram professional account" };
      if (ig.id !== expectedUserId || ig.username !== expectedUsername) {
        return { ok: false, detail: `linked Instagram is @${ig.username} (${ig.id}), expected @${expectedUsername} (${expectedUserId})` };
      }
      let quota = "";
      try {
        const q = await this.get<any>(`${ig.id}/content_publishing_limit?fields=config,quota_usage`, "ig quota");
        const d = q.data?.[0];
        if (d) quota = `; publishing quota used ${d.quota_usage}/${d.config?.quota_total ?? "?"} in 24 h`;
      } catch {
        /* optional */
      }
      return { ok: true, detail: `Instagram @${ig.username} (${ig.id})${quota}` };
    } catch (e) {
      return { ok: false, detail: `Instagram check failed: ${graphError(e)}` };
    }
  }

  /** Requires META_APP_ID/META_APP_SECRET; reports scopes, token type and expiry without printing the token. */
  async tokenInfo(appId?: string, appSecret?: string): Promise<IdentityCheck> {
    if (!appId || !appSecret) return { ok: false, detail: "META_APP_ID / META_APP_SECRET not set; cannot inspect token permissions (debug_token)" };
    try {
      const r = await json<any>(`${this.url("debug_token")}?${new URLSearchParams({ input_token: this.token })}`, {
        label: "meta debug_token",
        headers: { authorization: `Bearer ${appId}|${appSecret}` },
      });
      const d = r.data ?? {};
      const scopes: string[] = d.scopes ?? [];
      const missing = META_REQUIRED_PERMISSIONS.filter((p) => !scopes.includes(p));
      const exp = !d.expires_at ? "never expires" : `expires ${new Date(d.expires_at * 1000).toISOString()}`;
      return {
        ok: d.is_valid === true && missing.length === 0,
        detail: `token type ${d.type ?? "?"}, valid=${d.is_valid}, ${exp}; ${missing.length ? `MISSING permissions: ${missing.join(", ")}` : "all required permissions granted"}`,
      };
    } catch (e) {
      return { ok: false, detail: `debug_token failed: ${graphError(e)}` };
    }
  }

  // ------------------------------------------------------------------ Instagram

  async instagram(igUserId: string, kind: "REELS" | "STORIES", videoUrl: string, caption: string | null, gate: Gate, progress: Progress): Promise<Outcome> {
    const params: Record<string, string> = { media_type: kind, video_url: videoUrl };
    if (kind === "REELS") {
      params.share_to_feed = "true";
      if (caption) params.caption = caption;
    }
    let container: string;
    try {
      container = (await this.post<{ id: string }>(`${igUserId}/media`, params, "ig container")).id;
    } catch (e) {
      // A container is never public by itself; failing here cannot have published anything.
      throw new SafeFailure(`Instagram container creation failed: ${graphError(e)}`);
    }
    await progress("processing", container, "media container created; waiting for Instagram processing");
    const deadline = Date.now() + this.pollMaxMinutes * 60_000;
    let status = "IN_PROGRESS";
    while (Date.now() < deadline) {
      await sleep(10_000);
      try {
        const s = await this.get<{ status_code: string; status?: string }>(`${container}?fields=status_code,status`, "ig container status");
        status = s.status_code;
        if (status === "FINISHED") break;
        if (status === "ERROR" || status === "EXPIRED") return { status: "failed", remoteId: container, detail: `Instagram processing ${status}: ${s.status ?? ""}`.slice(0, 300) };
        if (status === "PUBLISHED") break;
      } catch {
        /* transient polling error: keep waiting */
      }
    }
    if (status !== "FINISHED" && status !== "PUBLISHED") {
      return { status: "failed", remoteId: container, detail: `Instagram processing did not finish within ${this.pollMaxMinutes} min; media_publish was NOT called, so nothing was published.` };
    }
    const g = await gate();
    if (!g.allowed) return { status: "disabled", remoteId: container, detail: `Not published: ${g.reason}` };
    let mediaId: string;
    try {
      mediaId = (await this.post<{ id: string }>(`${igUserId}/media_publish`, { creation_id: container }, "ig media_publish")).id;
    } catch (e) {
      classifySubmit(e, "Instagram media_publish");
    }
    await progress("processing", mediaId, "published by API; confirming");
    try {
      const m = await this.get<any>(`${mediaId}?fields=id,permalink,media_product_type,timestamp`, "ig media read-back");
      return { status: "confirmed", remoteId: m.id, url: m.permalink ?? null, detail: `${m.media_product_type ?? kind} published ${m.timestamp ?? ""}`.trim() };
    } catch (e) {
      return { status: "processing", remoteId: mediaId, detail: `Publish call returned media ${mediaId} but read-back failed (${graphError(e)}); run "reconcile" to confirm.` };
    }
  }

  // ------------------------------------------------------------------ Facebook

  /** rupload binary upload with one resume attempt. Upload is pre-publication: failures are safe. */
  private async rupload(uploadUrl: string, path: string, videoId: string): Promise<void> {
    const size = statSync(path).size;
    const send = async (offset: number) => {
      const res = await request(uploadUrl, {
        label: "fb rupload",
        method: "POST",
        headers: { authorization: `OAuth ${this.token}`, offset: String(offset), file_size: String(size) },
        body: readSlice(path, offset, size - offset),
        timeoutMs: 30 * 60_000,
      });
      const text = await res.text();
      if (!res.ok) throw new HttpStatusError(res.status, text.slice(0, 300), "fb rupload");
    };
    try {
      await send(0);
    } catch (e) {
      try {
        const st = await this.get<any>(`${videoId}?fields=status`, "fb upload status");
        const done = Number(st.status?.uploading_phase?.bytes_transferred ?? 0);
        await send(done);
      } catch (e2) {
        throw new SafeFailure(`Facebook upload failed (nothing published): ${graphError(e2 ?? e)}`);
      }
    }
  }

  private async pollFacebookVideo(videoId: string, label: string): Promise<Outcome> {
    const deadline = Date.now() + this.pollMaxMinutes * 60_000;
    let last = "";
    while (Date.now() < deadline) {
      await sleep(10_000);
      try {
        const v = await this.get<any>(`${videoId}?fields=status,permalink_url,published`, `${label} status`);
        const vs = v.status?.video_status;
        const pub = v.status?.publishing_phase?.status;
        last = `video_status=${vs ?? "?"}, publishing=${pub ?? "?"}`;
        if (vs === "error" || pub === "error") return { status: "failed", remoteId: videoId, detail: `${label}: ${last} ${JSON.stringify(v.status?.processing_phase?.errors ?? "")}`.slice(0, 300) };
        if (vs === "ready" && (pub === "complete" || pub === undefined || v.published === true)) {
          const url = v.permalink_url ? (String(v.permalink_url).startsWith("http") ? v.permalink_url : `https://www.facebook.com${v.permalink_url}`) : null;
          return { status: "confirmed", remoteId: videoId, url, detail: `${label} ready and published` };
        }
      } catch {
        /* transient */
      }
    }
    return { status: "processing", remoteId: videoId, detail: `${label} still processing after ${this.pollMaxMinutes} min (${last}); run "reconcile" later.` };
  }

  async facebookReel(pageId: string, path: string, description: string, gate: Gate, progress: Progress): Promise<Outcome> {
    let start: { video_id: string; upload_url: string };
    try {
      start = await this.post(`${pageId}/video_reels`, { upload_phase: "start" }, "fb reel start");
    } catch (e) {
      throw new SafeFailure(`Facebook Reel start failed: ${graphError(e)}`);
    }
    await progress("initiated", start.video_id, "upload session started");
    await this.rupload(start.upload_url, path, start.video_id);
    const g = await gate();
    if (!g.allowed) return { status: "disabled", remoteId: start.video_id, detail: `Uploaded but not published: ${g.reason}` };
    try {
      await this.post(`${pageId}/video_reels`, { upload_phase: "finish", video_id: start.video_id, video_state: "PUBLISHED", description }, "fb reel finish");
    } catch (e) {
      classifySubmit(e, "Facebook Reel finish");
    }
    await progress("processing", start.video_id, "publish requested; processing");
    return this.pollFacebookVideo(start.video_id, "Facebook Reel");
  }

  async facebookStory(pageId: string, path: string, gate: Gate, progress: Progress): Promise<Outcome> {
    let start: { video_id: string; upload_url: string };
    try {
      start = await this.post(`${pageId}/video_stories`, { upload_phase: "start" }, "fb story start");
    } catch (e) {
      throw new SafeFailure(`Facebook Story start failed: ${graphError(e)}`);
    }
    await progress("initiated", start.video_id, "upload session started");
    await this.rupload(start.upload_url, path, start.video_id);
    const g = await gate();
    if (!g.allowed) return { status: "disabled", remoteId: start.video_id, detail: `Uploaded but not published: ${g.reason}` };
    let finish: { success?: boolean; post_id?: string };
    try {
      finish = await this.post(`${pageId}/video_stories`, { upload_phase: "finish", video_id: start.video_id }, "fb story finish");
    } catch (e) {
      classifySubmit(e, "Facebook Story finish");
    }
    await progress("processing", finish.post_id ?? start.video_id, "story published by API; confirming");
    const o = await this.pollFacebookVideo(start.video_id, "Facebook Story");
    return { ...o, remoteId: finish.post_id ?? start.video_id, url: null };
  }

  /** Regular Page video via the resumable chunked /videos protocol (for sources that are not Reel-eligible). */
  async facebookPageVideo(pageId: string, path: string, title: string, description: string, gate: Gate, progress: Progress): Promise<Outcome> {
    const size = statSync(path).size;
    const base = "https://graph-video.facebook.com";
    let s: { upload_session_id: string; video_id: string; start_offset: string; end_offset: string };
    try {
      s = await this.post(`${pageId}/videos`, { upload_phase: "start", file_size: String(size) }, "fb video start", base);
    } catch (e) {
      throw new SafeFailure(`Facebook video start failed: ${graphError(e)}`);
    }
    await progress("initiated", s.video_id, "upload session started");
    let startOff = Number(s.start_offset);
    let endOff = Number(s.end_offset);
    let retries = 0;
    while (startOff < endOff) {
      const form = new FormData();
      form.set("upload_phase", "transfer");
      form.set("upload_session_id", s.upload_session_id);
      form.set("start_offset", String(startOff));
      form.set("video_file_chunk", new Blob([readSlice(path, startOff, endOff - startOff)]), "chunk");
      try {
        const r = await json<{ start_offset: string; end_offset: string }>(`${base}/${this.version}/${pageId}/videos`, { label: "fb video transfer", method: "POST", headers: this.h(), body: form, timeoutMs: 10 * 60_000 });
        startOff = Number(r.start_offset);
        endOff = Number(r.end_offset);
        retries = 0;
      } catch (e) {
        if (++retries > 3) throw new SafeFailure(`Facebook video transfer failed (nothing published): ${graphError(e)}`);
        await sleep(5000 * retries);
      }
    }
    const g = await gate();
    if (!g.allowed) return { status: "disabled", remoteId: s.video_id, detail: `Uploaded but not published: ${g.reason}` };
    try {
      await this.post(`${pageId}/videos`, { upload_phase: "finish", upload_session_id: s.upload_session_id, title, description, published: "true" }, "fb video finish", base);
    } catch (e) {
      classifySubmit(e, "Facebook video finish");
    }
    await progress("processing", s.video_id, "publish requested; processing");
    return this.pollFacebookVideo(s.video_id, "Facebook Page video");
  }

  /** Read-only status refresh used by "reconcile". */
  async refresh(kind: "instagram" | "facebook", remoteId: string): Promise<Outcome | null> {
    try {
      if (kind === "instagram") {
        const m = await this.get<any>(`${remoteId}?fields=id,permalink,media_product_type`, "ig reconcile");
        if (m.permalink || m.media_product_type) return { status: "confirmed", remoteId: m.id, url: m.permalink ?? null, detail: "confirmed by reconcile" };
        return null;
      }
      const v = await this.get<any>(`${remoteId}?fields=status,permalink_url`, "fb reconcile");
      if (v.status?.video_status === "ready") return { status: "confirmed", remoteId, url: v.permalink_url ? `https://www.facebook.com${v.permalink_url}` : null, detail: "confirmed by reconcile" };
      if (v.status?.video_status === "error") return { status: "failed", remoteId, detail: "provider reports processing error" };
      return null;
    } catch {
      return null;
    }
  }
}

export function readSlice(path: string, offset: number, length: number): Uint8Array<ArrayBuffer> {
  const buf = new Uint8Array(new ArrayBuffer(length));
  if (offset === 0 && length === statSync(path).size) {
    buf.set(readFileSync(path));
    return buf;
  }
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, length, offset);
    return buf;
  } finally {
    closeSync(fd);
  }
}
