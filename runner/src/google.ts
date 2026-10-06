// Google auth (service account for Drive; OAuth refresh token for YouTube) and Drive access.
import { createSign, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { HttpStatusError, json, request } from "./http";
import { registerSecret } from "../../src/shared/redact";
import type { FolderVideo, EntrySource } from "../../src/shared/selection";
import type { StateClient } from "./state-client";

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

export async function serviceAccountToken(saJson: string, scopes: string[]): Promise<string> {
  const sa = JSON.parse(saJson) as { client_email: string; private_key: string; token_uri?: string };
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({ iss: sa.client_email, scope: scopes.join(" "), aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claim}`);
  const jwt = `${header}.${claim}.${b64url(signer.sign(sa.private_key))}`;
  const res = await json<{ access_token: string }>("https://oauth2.googleapis.com/token", {
    label: "google service-account token",
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  registerSecret(res.access_token);
  return res.access_token;
}

export function serviceAccountEmail(saJson: string): string {
  return JSON.parse(saJson).client_email;
}

// ---------------------------------------------------------------------------
// Rotated-credential persistence: encrypted here with AES-256-GCM, stored opaquely in D1 via the Worker.

export function encrypt(keyB64: string, plaintext: string): string {
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== 32) throw new Error("CREDENTIALS_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString("base64")).join(".");
}

export function decrypt(keyB64: string, payload: string): string {
  const key = Buffer.from(keyB64, "base64");
  const [iv, tag, ct] = payload.split(".").map((p) => Buffer.from(p, "base64"));
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
  refreshToken: string; // initial value from the GitHub secret
  encryptionKey?: string;
  state?: StateClient;
  credentialName: string; // e.g. "youtube_refresh_token"
}

/** Refresh an OAuth access token; if Google rotates the refresh token, persist the new one (encrypted). */
export async function oauthAccessToken(c: OAuthClient): Promise<{ accessToken: string; scopes: string[]; rotated: boolean }> {
  let refresh = c.refreshToken;
  if (c.state && c.encryptionKey) {
    const stored = (await c.state.getCredential(c.credentialName)).credential;
    if (stored) refresh = decrypt(c.encryptionKey, stored.ciphertext);
  }
  registerSecret(refresh);
  let res: { access_token: string; refresh_token?: string; scope?: string };
  try {
    res = await json("https://oauth2.googleapis.com/token", {
      label: "google oauth refresh",
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: c.clientId, client_secret: c.clientSecret, refresh_token: refresh }),
    });
  } catch (e) {
    if (e instanceof HttpStatusError && /invalid_grant/.test(e.bodySummary)) {
      throw new Error(
        "Google refused the YouTube refresh token (invalid_grant): it was revoked or expired. If the OAuth consent screen is in 'Testing' status, refresh tokens expire after 7 days — publish the app to 'In production' and re-authorize.",
      );
    }
    throw e;
  }
  registerSecret(res.access_token);
  let rotated = false;
  if (res.refresh_token && res.refresh_token !== refresh && c.state && c.encryptionKey) {
    registerSecret(res.refresh_token);
    await c.state.putCredential(c.credentialName, encrypt(c.encryptionKey, res.refresh_token));
    rotated = true;
  }
  return { accessToken: res.access_token, scopes: (res.scope ?? "").split(" ").filter(Boolean), rotated };
}

// ---------------------------------------------------------------------------
// Drive

export const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive.readonly", "https://www.googleapis.com/auth/drive.activity.readonly"];

export class Drive {
  constructor(private token: string, private folderId: string) {}

  private h() {
    return { authorization: `Bearer ${this.token}` };
  }

  async folder(): Promise<{ id: string; name: string; mimeType: string }> {
    const u = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(this.folderId)}?fields=id,name,mimeType&supportsAllDrives=true`;
    return json(u, { label: "drive folder", headers: this.h() });
  }

  /** Lists videos directly in the folder. Throws on any auth/network error — never returns an empty list on failure. */
  async listVideos(): Promise<FolderVideo[]> {
    const out: FolderVideo[] = [];
    let pageToken: string | undefined;
    do {
      const q = `'${this.folderId}' in parents and trashed = false and mimeType contains 'video/'`;
      const params = new URLSearchParams({
        q,
        fields: "nextPageToken, files(id,name,mimeType,size,md5Checksum,createdTime,modifiedTime)",
        pageSize: "1000",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
        orderBy: "createdTime",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const r = await json<any>(`https://www.googleapis.com/drive/v3/files?${params}`, { label: "drive list", headers: this.h() });
      for (const f of r.files ?? []) {
        out.push({ id: f.id, name: f.name, mimeType: f.mimeType, sizeBytes: f.size ? Number(f.size) : null, md5: f.md5Checksum ?? null, createdTime: f.createdTime, modifiedTime: f.modifiedTime });
      }
      pageToken = r.nextPageToken;
    } while (pageToken);
    return out;
  }

  /**
   * Folder-entry times from the Drive Activity API: the latest CREATE (upload/new/copy) or MOVE whose
   * added parent is this folder. Files without such an event in the available history are omitted.
   */
  async folderEntryTimes(): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    let pageToken: string | undefined;
    let pages = 0;
    do {
      const body: any = { ancestorName: `items/${this.folderId}`, filter: "detail.action_detail_case:(CREATE MOVE)", pageSize: 100 };
      if (pageToken) body.pageToken = pageToken;
      const r = await json<any>("https://driveactivity.googleapis.com/v2/activity:query", {
        label: "drive activity",
        method: "POST",
        headers: { ...this.h(), "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      for (const act of r.activities ?? []) {
        const time: string | undefined = act.timestamp ?? act.timeRange?.endTime;
        if (!time) continue;
        for (const action of act.actions ?? [act.primaryActionDetail ? { detail: act.primaryActionDetail } : null].filter(Boolean)) {
          const d = action.detail ?? {};
          let entered = false;
          if (d.create) entered = true;
          if (d.move) entered = (d.move.addedParents ?? []).some((p: any) => p?.driveItem?.name === `items/${this.folderId}`);
          if (!entered) continue;
          const targets = action.target ? [action.target] : act.targets ?? [];
          const t = action.timestamp ?? time;
          for (const tg of targets) {
            const name: string | undefined = tg?.driveItem?.name;
            if (!name?.startsWith("items/")) continue;
            const id = name.slice(6);
            if (id === this.folderId) continue;
            const prev = result.get(id);
            if (!prev || t > prev) result.set(id, t);
          }
        }
      }
      pageToken = r.nextPageToken;
      pages++;
    } while (pageToken && pages < 50);
    return result;
  }

  /** Is the file still directly in the folder and not trashed? */
  async stillInFolder(fileId: string): Promise<boolean> {
    try {
      const f = await json<any>(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,trashed,parents&supportsAllDrives=true`, { label: "drive file", headers: this.h() });
      return !f.trashed && (f.parents ?? []).includes(this.folderId);
    } catch (e) {
      if (e instanceof HttpStatusError && e.status === 404) return false;
      throw e;
    }
  }

  async download(fileId: string, dest: string): Promise<void> {
    const res = await request(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`, {
      label: "drive download",
      headers: this.h(),
      timeoutMs: 30 * 60_000,
    });
    if (!res.ok || !res.body) throw new HttpStatusError(res.status, "download failed", "drive download");
    await pipeline(Readable.fromWeb(res.body as any), createWriteStream(dest));
  }
}

/** Sync folder-entry knowledge into the state store. Exact activity times beat observation, which beats createdTime. */
export async function syncEntryTimes(drive: Drive, state: StateClient, videos: FolderVideo[], known: Map<string, { entrySource: EntrySource | null }>) {
  const notes: string[] = [];
  let activity = new Map<string, string>();
  try {
    activity = await drive.folderEntryTimes();
  } catch (e) {
    notes.push(`Drive Activity API unavailable (${(e as Error).message.slice(0, 120)}); entry times fall back to first observation / createdTime approximation.`);
  }
  const items = videos.map((v) => {
    const at = activity.get(v.id);
    if (at) return { fileId: v.id, name: v.name, enteredFolderAt: at, entrySource: "drive_activity" as EntrySource };
    if (!known.has(v.id)) {
      // First time we see a file without activity history: record createdTime as a labelled approximation.
      return { fileId: v.id, name: v.name, enteredFolderAt: v.createdTime, entrySource: "created_time_approximation" as EntrySource };
    }
    return { fileId: v.id, name: v.name, enteredFolderAt: null, entrySource: "created_time_approximation" as EntrySource };
  });
  if (items.length) await state.observe(items.filter((i) => i.enteredFolderAt !== null || !known.has(i.fileId)));
  return { notes, exactCount: [...activity.keys()].filter((k) => videos.some((v) => v.id === k)).length };
}
