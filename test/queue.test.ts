import { describe, expect, it, vi, afterEach } from "vitest";
import { maintainQueue, confirmedForCleanup, latestPublications, type PublicationCheckpoint } from "../runner/src/queue";
import { Drive, DRIVE_SCOPES } from "../runner/src/google";
import { selectVideo, type FolderVideo } from "../src/shared/selection";
import { isRetryable } from "../src/shared/status";
import { executeTasks, type Task } from "../runner/src/publish";

const video: FolderVideo = { id: "video1", name: "lesson.mp4", mimeType: "video/mp4", sizeBytes: 1, md5: "hash", createdTime: "2026-10-01T00:00:00Z", modifiedTime: "2026-10-01T00:00:00Z" };
const row = (id: number, platform: string, status: PublicationCheckpoint["status"], surface = "feed"): PublicationCheckpoint => ({ id, file_id: video.id, platform, surface, status });
const deps = (rows: PublicationCheckpoint[]) => ({ publications: vi.fn(async () => rows), trash: vi.fn(async () => {}), complete: vi.fn(async () => {}) });

describe("folder queue and temporary recovery checkpoints", () => {
  it("allows explicit recovery of failed/skipped destinations, never confirmed or pending ones", () => {
    for (const status of ["failed", "disabled"] as const) expect(isRetryable(status)).toBe(true);
    for (const status of ["confirmed", "initiated", "processing", "uncertain", "unsupported"] as const) expect(isRetryable(status)).toBe(false);
  });
  it("cleans up only after supported destinations confirm, then advances using the live folder", async () => {
    const d = deps([row(1, "instagram", "confirmed"), row(2, "tiktok", "unsupported", "story")]);
    const q = await maintainQueue([video], new Set(), d);
    expect(d.trash).toHaveBeenCalledExactlyOnceWith(video.id);
    expect(d.complete).toHaveBeenCalledExactlyOnceWith(video.id);
    expect(d.trash.mock.invocationCallOrder[0]).toBeLessThan(d.complete.mock.invocationCallOrder[0]);
    const next = { ...video, id: "video2", createdTime: "2026-10-02T00:00:00Z" };
    expect(selectVideo({ policy: "fifo", videos: [video, next], records: new Map(), blockedIds: q.blockedIds }).video?.id).toBe(next.id);
  });

  it.each(["initiated", "processing", "uncertain", "failed", "disabled"] as const)("retains the source when one destination is %s", async (status) => {
    const d = deps([row(1, "instagram", "confirmed"), row(2, "facebook", status)]);
    const q = await maintainQueue([video], new Set(), d);
    expect(q.blockedIds.has(video.id)).toBe(true);
    expect(d.trash).not.toHaveBeenCalled();
    expect(d.complete).not.toHaveBeenCalled();
  });

  it("does not delete empty/all-unsupported or wholly failed plans", async () => {
    for (const rows of [[], [row(1, "tiktok", "unsupported")], [row(1, "facebook", "failed")]]) {
      const d = deps(rows);
      const q = await maintainQueue([video], new Set(), d);
      expect(q.blockedIds.size).toBe(0);
      expect(d.trash).not.toHaveBeenCalled();
    }
  });

  it("combines a successful retry with previously confirmed destinations without losing remaining failures", () => {
    const rows = [row(1, "instagram", "confirmed"), row(2, "facebook", "failed"), row(3, "youtube", "failed"), row(4, "facebook", "confirmed")];
    expect(confirmedForCleanup(rows)).toBe(false);
    rows.push(row(5, "youtube", "confirmed"));
    expect(confirmedForCleanup(rows.reverse())).toBe(true);
    expect(latestPublications(rows)).toHaveLength(3);
  });

  it("retries a cleanup failure without permitting another upload or clearing checkpoints", async () => {
    const d = deps([row(1, "facebook", "confirmed")]);
    d.trash.mockRejectedValueOnce(new Error("permission denied"));
    const q = await maintainQueue([video], new Set(), d);
    expect(q.blockedIds.has(video.id)).toBe(true);
    expect(q.notes.join()).toMatch(/permission denied/);
    expect(d.complete).not.toHaveBeenCalled();
    await maintainQueue([video], new Set(), d);
    expect(d.trash).toHaveBeenCalledTimes(2);
    expect(d.complete).toHaveBeenCalledTimes(1);
  });

  it("preserves named and configured outro assets, even when explicitly published", async () => {
    const d = deps([row(1, "facebook", "confirmed")]);
    await maintainQueue([video, { ...video, id: "outro", name: "outro.mp4" }], new Set([video.id]), d);
    expect(d.publications).not.toHaveBeenCalled();
    expect(d.trash).not.toHaveBeenCalled();
  });

  it("preview computes exclusions without removing files or checkpoints", async () => {
    const d = deps([row(1, "facebook", "confirmed")]);
    const q = await maintainQueue([video], new Set(), d, true);
    expect(q.blockedIds.has(video.id)).toBe(true);
    expect(d.trash).not.toHaveBeenCalled();
    expect(d.complete).not.toHaveBeenCalled();
  });

  it("fails closed if checkpoint state cannot be read", async () => {
    const d = deps([]);
    d.publications.mockRejectedValue(new Error("state unavailable"));
    await expect(maintainQueue([video], new Set(), d)).rejects.toThrow(/state unavailable/);
    expect(d.trash).not.toHaveBeenCalled();
  });

  it("does not trash an interrupted multi-destination upload after only its first destination confirms", async () => {
    const rows = new Map<string, PublicationCheckpoint>();
    const tasks: Task[] = ["instagram", "facebook"].map((platform) => ({ platform: platform as "instagram" | "facebook", surface: "feed", provider: "p", format: "f", needsUrl: false, run: async () => ({ status: "confirmed" }) }));
    await expect(executeTasks("run", video.id, tasks, { mayPublish: async () => ({ allowed: true, reason: null }), record: async (r) => {
      if (r.platform === "facebook" && r.status === "initiated") throw new Error("interrupted");
      rows.set(r.platform, { id: r.platform === "instagram" ? 1 : 2, file_id: video.id, platform: r.platform, surface: r.surface, status: r.status });
    } })).rejects.toThrow(/interrupted/);
    expect(rows.get("instagram")?.status).toBe("confirmed");
    expect(rows.get("facebook")?.status).toBe("disabled");
    const d = deps([...rows.values()]);
    expect((await maintainQueue([video], new Set(), d)).blockedIds.has(video.id)).toBe(true);
    expect(d.trash).not.toHaveBeenCalled();
  });

  it("keeps a durable duplicate guard if the final provider confirmation cannot be saved", async () => {
    let checkpoint = row(1, "facebook", "disabled");
    await executeTasks("run", video.id, [{ platform: "facebook", surface: "feed", provider: "p", format: "f", needsUrl: false, run: async () => ({ status: "confirmed" }) }], {
      mayPublish: async () => ({ allowed: true, reason: null }), record: async (r) => {
        if (r.status === "confirmed") throw new Error("state unavailable");
        checkpoint = { ...checkpoint, status: r.status };
      },
    });
    expect(checkpoint.status).toBe("initiated");
    const d = deps([checkpoint]);
    expect((await maintainQueue([video], new Set(), d)).blockedIds.has(video.id)).toBe(true);
    expect(d.trash).not.toHaveBeenCalled();
  });
});

describe("Drive source removal", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("uses write scope, checks permissions and membership, and confirms recoverable trash", async () => {
    expect(DRIVE_SCOPES).toContain("https://www.googleapis.com/auth/drive");
    let trashed = false;
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === "PATCH") {
        expect(JSON.parse(String(init.body))).toEqual({ trashed: true });
        trashed = true;
      }
      return Response.json({ id: video.id, trashed, parents: ["folder"], capabilities: { canTrash: true } });
    });
    vi.stubGlobal("fetch", fetch);
    await new Drive("token", "folder").trash(video.id);
    expect(fetch.mock.calls.filter(([, init]) => init.method === "PATCH")).toHaveLength(1);
    expect(fetch.mock.calls.every(([url]) => url.includes("supportsAllDrives=true"))).toBe(true);
  });

  it("never modifies a source moved elsewhere, and handles already removed files", async () => {
    const fetch = vi.fn(async () => Response.json({ parents: ["elsewhere"], trashed: false }));
    vi.stubGlobal("fetch", fetch);
    await new Drive("token", "folder").trash(video.id);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reports missing owner permission before attempting trash", async () => {
    const fetch = vi.fn(async () => Response.json({ parents: ["folder"], capabilities: { canTrash: false } }));
    vi.stubGlobal("fetch", fetch);
    await expect(new Drive("token", "folder").trash(video.id)).rejects.toThrow(/file owner/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not accept an unconfirmed trash response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ parents: ["folder"], trashed: false, capabilities: { canTrash: true } })));
    await expect(new Drive("token", "folder").trash(video.id)).rejects.toThrow(/did not confirm/);
  });
});
