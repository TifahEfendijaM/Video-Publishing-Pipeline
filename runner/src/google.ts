// Google auth (service account for Drive; OAuth refresh token for YouTube) and Drive access.
import { createSign, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { HttpStatusError, json, request } from "./http";
import { registerSecret } from "../../src/shared/redact";
import type { FolderVideo } from "../../src/shared/selection";
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

export const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive"];

export class Drive {
  private archiveFolderId?: string;
  constructor(private token: string, private folderId: string, private archiveOptions: { folderId?: string; folderName?: string } = {}) {}

  private async metadata(fileId: string): Promise<any> {
    return json(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,trashed,parents,capabilities(canAddChildren,canMoveItemWithinDrive)&supportsAllDrives=true`, { label: "drive archive metadata", headers: this.h() });
  }

  /** Resolve a configured archive, or find/create a child folder. Read-only checks never create it. */
  async publishedFolder(create = false): Promise<{ id: string; name: string; capabilities?: { canAddChildren?: boolean } } | null> {
    const explicit = this.archiveOptions.folderId || this.archiveFolderId;
    if (explicit) {
      if (explicit === this.folderId) throw new Error("Published videos folder must differ from the source folder");
      const folder = await this.metadata(explicit);
      if (folder.trashed || folder.mimeType !== "application/vnd.google-apps.folder") throw new Error("Published videos destination is not an active Drive folder");
      return folder;
    }
    const name = this.archiveOptions.folderName || "Published videos";
    const escape = (v: string) => v.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const params = new URLSearchParams({ q: `'${escape(this.folderId)}' in parents and name = '${escape(name)}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`, fields: "nextPageToken,files(id,name,capabilities(canAddChildren))", pageSize: "1000", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
    const found = await json<any>(`https://www.googleapis.com/drive/v3/files?${params}`, { label: "drive published folder", headers: this.h() });
    if (found.nextPageToken || found.files?.length > 1) throw new Error("Multiple Published videos folders found; set PUBLISHED_DRIVE_FOLDER_ID to choose one");
    if (found.files?.length === 1) {
      this.archiveFolderId = found.files[0].id;
      return found.files[0];
    }
    if (!create) return null;
    const folder = await json<any>("https://www.googleapis.com/drive/v3/files?fields=id,name,capabilities(canAddChildren)&supportsAllDrives=true", { label: "drive create published folder", method: "POST", headers: { ...this.h(), "content-type": "application/json" }, body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [this.folderId] }) });
    this.archiveFolderId = folder.id;
    return folder;
  }

  async canArchive(fileId: string): Promise<boolean> {
    const source = await this.metadata(fileId);
    const archive = await this.publishedFolder(false);
    const destination = archive ?? await this.metadata(this.folderId);
    return source.capabilities?.canMoveItemWithinDrive === true && destination.capabilities?.canAddChildren === true;
  }

  private h() {
    return { authorization: `Bearer ${this.token}` };
  }

  async folder(): Promise<{ id: string; name: string; mimeType: string }> {
    const u = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(this.folderId)}?fields=id,name,mimeType&supportsAllDrives=true`;
    return json(u, { label: "drive folder", headers: this.h() });
  }

  /** Lists videos directly in the folder. Throws on any auth/network error — never returns an empty list on failure. */
  async listVideos(folderId = this.folderId): Promise<FolderVideo[]> {
    const out: FolderVideo[] = [];
    let pageToken: string | undefined;
    do {
      const q = `'${folderId}' in parents and trashed = false and mimeType contains 'video/'`;
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

  /** Atomically move a confirmed source, then verify both parents before clearing checkpoints. */
  async archive(fileId: string): Promise<void> {
    const source = await this.metadata(fileId);
    if (source.trashed) throw new Error("Source is trashed; cannot confirm archival");
    const destination = await this.publishedFolder((source.parents ?? []).includes(this.folderId));
    if (!destination) throw new Error("Published videos folder is unavailable; source checkpoints retained");
    if (!(source.parents ?? []).includes(this.folderId)) {
      if ((source.parents ?? []).includes(destination.id)) return; // response lost on an earlier move
      throw new Error("Source is no longer in the input folder and is not in Published videos; checkpoints retained");
    }
    if (!source.capabilities?.canMoveItemWithinDrive || !destination.capabilities?.canAddChildren) throw new Error("Drive identity cannot move this source to Published videos. Grant Editor access to the source/archive folders, or configure GOOGLE_DRIVE_* OAuth credentials with move permission.");
    const params = new URLSearchParams({ addParents: destination.id, removeParents: this.folderId, fields: "id,parents,trashed", supportsAllDrives: "true" });
    await json(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?${params}`, {
      label: "drive archive confirmed source", method: "PATCH", headers: { ...this.h(), "content-type": "application/json" }, body: "{}",
    });
    const moved = await this.metadata(fileId);
    if (moved.trashed || !(moved.parents ?? []).includes(destination.id) || (moved.parents ?? []).includes(this.folderId)) throw new Error("Drive did not confirm the move to Published videos; checkpoints retained");
  }
}
