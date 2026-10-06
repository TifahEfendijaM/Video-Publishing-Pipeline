// YouTube Data API v3 (official): resumable videos.insert + status read-back.
// Videos uploaded through an UNAUDITED API project are locked to private — OAuth consent does not lift that.
import { statSync } from "node:fs";
import { HttpStatusError, NetworkError, json, request, sleep } from "../http";
import { AmbiguousOutcome, SafeFailure } from "../../../src/shared/status";
import { summarizeError } from "../../../src/shared/redact";
import { readSlice } from "./meta";
import type { Gate, IdentityCheck, Outcome, Progress } from "./types";

const CHUNK = 16 * 1024 * 1024; // multiple of 256 KiB

export class YouTube {
  constructor(private accessToken: string, private pollMaxMinutes: number) {}
  private h(extra: Record<string, string> = {}) {
    return { authorization: `Bearer ${this.accessToken}`, ...extra };
  }

  async verify(expectedChannelId: string, expectedHandle: string, scopes: string[]): Promise<IdentityCheck> {
    if (!expectedChannelId && !expectedHandle) return { ok: false, detail: "neither expectedChannelId nor expectedChannelHandle is configured" };
    try {
      const r = await json<any>("https://www.googleapis.com/youtube/v3/channels?part=id,snippet,status&mine=true", { label: "youtube channels", headers: this.h() });
      const ch = (r.items ?? []) as any[];
      const handle = expectedHandle.toLowerCase().replace(/^@?/, "@");
      const c = ch.find((x) => (expectedChannelId ? x.id === expectedChannelId : String(x.snippet?.customUrl ?? "").toLowerCase() === handle));
      if (!c) {
        return { ok: false, detail: `authorized account owns ${ch.map((x) => `${x.snippet?.title} ${x.snippet?.customUrl ?? ""} (${x.id})`).join(", ") || "no channel"}, not ${expectedChannelId || expectedHandle}` };
      }
      if (expectedChannelId && expectedHandle && String(c.snippet?.customUrl ?? "").toLowerCase() !== handle) {
        return { ok: false, detail: `channel ${c.id} has handle ${c.snippet?.customUrl}, expected ${expectedHandle}` };
      }
      const hasUpload = scopes.some((s) => /youtube\.upload|auth\/youtube$/.test(s));
      return {
        ok: hasUpload,
        detail: `YouTube channel "${c.snippet?.title}" ${c.snippet?.customUrl ?? ""} — channel ID ${c.id}${expectedChannelId ? "" : " (copy into expectedChannelId to pin it)"}; long uploads ${c.status?.longUploadsStatus ?? "?"}; upload scope ${hasUpload ? "granted" : "MISSING"}`,
      };
    } catch (e) {
      return { ok: false, detail: `YouTube check failed: ${summarizeError(e, 200)}` };
    }
  }

  async upload(path: string, meta: { title: string; description: string; categoryId: string; madeForKids: boolean; privacyStatus: "public" | "private" }, gate: Gate, progress: Progress): Promise<Outcome> {
    const size = statSync(path).size;
    const g = await gate();
    if (!g.allowed) return { status: "disabled", detail: `Not uploaded: ${g.reason}` };
    let session: string;
    try {
      const res = await request("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
        label: "youtube init",
        method: "POST",
        headers: this.h({ "content-type": "application/json; charset=UTF-8", "x-upload-content-length": String(size), "x-upload-content-type": "video/*" }),
        body: JSON.stringify({
          snippet: { title: meta.title, description: meta.description, categoryId: meta.categoryId, defaultLanguage: "bs", defaultAudioLanguage: "bs" },
          status: { privacyStatus: meta.privacyStatus, selfDeclaredMadeForKids: meta.madeForKids, embeddable: true },
        }),
      });
      if (!res.ok) throw new HttpStatusError(res.status, (await res.text()).slice(0, 300), "youtube init");
      session = res.headers.get("location") ?? "";
      if (!session) throw new Error("no upload session URL");
    } catch (e) {
      throw new SafeFailure(`YouTube upload session not created (nothing uploaded): ${summarizeError(e, 250)}`);
    }
    await progress("initiated", null, "resumable upload session created");

    let offset = 0;
    let video: any = null;
    let failures = 0;
    while (!video) {
      const end = Math.min(offset + CHUNK, size) - 1;
      try {
        const res = await request(session, {
          label: "youtube chunk",
          method: "PUT",
          headers: { "content-length": String(end - offset + 1), "content-range": `bytes ${offset}-${end}/${size}` },
          body: readSlice(path, offset, end - offset + 1),
          timeoutMs: 15 * 60_000,
        });
        if (res.status === 200 || res.status === 201) video = await res.json();
        else if (res.status === 308) {
          const range = res.headers.get("range");
          offset = range ? Number(range.split("-")[1]) + 1 : 0;
          failures = 0;
        } else if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
        else throw new SafeFailure(`YouTube rejected the upload: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      } catch (e) {
        if (e instanceof SafeFailure) throw e;
        if (++failures > 5) throw new AmbiguousOutcome(`YouTube upload interrupted repeatedly (${summarizeError(e, 120)}); a partial/complete video may exist — check YouTube Studio, then resolve.`);
        await sleep(2000 * 2 ** failures);
        // Ask the server how much it has (resumable protocol), then continue from there.
        try {
          const st = await request(session, { label: "youtube status", method: "PUT", headers: { "content-length": "0", "content-range": `bytes */${size}` } });
          if (st.status === 200 || st.status === 201) video = await st.json();
          else if (st.status === 308) {
            const range = st.headers.get("range");
            offset = range ? Number(range.split("-")[1]) + 1 : 0;
          }
        } catch {
          /* retry loop */
        }
      }
    }
    const id: string = video.id;
    await progress("processing", id, "uploaded; YouTube is processing");
    const requestedPublic = meta.privacyStatus === "public";
    if (requestedPublic && video.status?.privacyStatus === "private") {
      return {
        status: "unsupported",
        remoteId: id,
        url: `https://youtu.be/${id}`,
        detail: "Uploaded but YouTube locked it to PRIVATE (unaudited API project). Manual step: make it public in YouTube Studio, or complete the YouTube API audit.",
      };
    }
    return this.poll(id, requestedPublic, this.pollMaxMinutes);
  }

  async poll(id: string, requestedPublic: boolean, maxMinutes: number): Promise<Outcome> {
    const deadline = Date.now() + maxMinutes * 60_000;
    let last = "";
    do {
      try {
        const r = await json<any>(`https://www.googleapis.com/youtube/v3/videos?part=status,processingDetails&id=${encodeURIComponent(id)}`, { label: "youtube status", headers: this.h() });
        const v = r.items?.[0];
        if (!v) return { status: "uncertain", remoteId: id, detail: "Video not found by read-back (deleted or not visible to this account)." };
        const up = v.status?.uploadStatus;
        const priv = v.status?.privacyStatus;
        last = `uploadStatus=${up}, privacy=${priv}`;
        if (up === "rejected" || up === "failed" || up === "deleted") return { status: "failed", remoteId: id, detail: `YouTube ${up}: ${v.status?.rejectionReason ?? v.status?.failureReason ?? ""}` };
        if (requestedPublic && priv === "private") return { status: "unsupported", remoteId: id, url: `https://youtu.be/${id}`, detail: "YouTube locked the video to PRIVATE (unaudited API project). Manual step required in YouTube Studio." };
        if (up === "processed" && (!requestedPublic || priv === "public")) return { status: requestedPublic ? "confirmed" : "unsupported", remoteId: id, url: `https://youtu.be/${id}`, detail: requestedPublic ? "processed and public" : "uploaded as PRIVATE by configuration; manual publishing required" };
      } catch (e) {
        if (e instanceof NetworkError || e instanceof HttpStatusError) {
          /* transient */
        } else throw e;
      }
      if (maxMinutes > 0) await sleep(15_000);
    } while (Date.now() < deadline);
    return { status: "processing", remoteId: id, url: `https://youtu.be/${id}`, detail: `still processing (${last}); run reconcile later.` };
  }
}
