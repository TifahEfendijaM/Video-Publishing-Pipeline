import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compressToSize, probe } from "../runner/src/media-tools";
import { KvHosting, SizeLimitedHosting } from "../runner/src/hosting";
import { executeTasks } from "../runner/src/publish";
import { selectRetryPublications } from "../runner/src/retry";

describe("free video hosting", () => {
  const dir = mkdtempSync(join(tmpdir(), "ebv-host-test-"));
  const src = join(dir, "source.mp4");
  const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  beforeAll(() => {
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=360x640:rate=30:duration=8",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=8", "-c:v", "libx264", "-crf", "16",
      "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", src]);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("two-pass encoding meets a tight byte limit, keeps audio/full frame/full duration, and preserves the source", async () => {
    const before = hash(src);
    const info = await probe(src);
    const maxBytes = 192 * 1024;
    expect(info.sizeBytes).toBeGreaterThan(maxBytes);
    const out = join(dir, "small.mp4");
    const encoded = await compressToSize(src, out, info, maxBytes);
    expect(encoded.sizeBytes).toBeLessThanOrEqual(maxBytes);
    expect(encoded).toMatchObject({ width: 360, height: 640, videoCodec: "h264", audioCodec: "aac", pixFmt: "yuv420p" });
    expect(Math.abs(encoded.durationSec - info.durationSec)).toBeLessThan(0.25);
    expect(hash(src)).toBe(before);
    // Content remains visible at both the start and end; neither end was cut to meet the budget.
    for (const time of [0, 7.5]) {
      const frame = execFileSync("ffmpeg", ["-v", "error", "-ss", String(time), "-i", out, "-frames:v", "1", "-vf", "scale=36:64", "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
      expect(frame.length).toBe(36 * 64);
      expect(Math.max(...frame) - Math.min(...frame)).toBeGreaterThan(100);
    }
  }, 60_000);

  it("refuses impossible budgets and source overwrite without truncating or replacing the source", async () => {
    const before = hash(src);
    const info = await probe(src);
    const out = join(dir, "impossible.mp4");
    await expect(compressToSize(src, out, info, 1024)).rejects.toThrow(/nothing was cut/);
    expect(existsSync(out)).toBe(false);
    await expect(compressToSize(src, src, info, KvHosting.MAX_BYTES)).rejects.toThrow(/overwrite/);
    expect(hash(src)).toBe(before);
  });

  it("also compresses clips without an audio stream", async () => {
    const silent = join(dir, "silent.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-i", src, "-c:v", "copy", "-an", silent]);
    const encoded = await compressToSize(silent, join(dir, "silent-small.mp4"), await probe(silent), 192 * 1024);
    expect(encoded.sizeBytes).toBeLessThanOrEqual(192 * 1024);
    expect(encoded.audioCodec).toBeNull();
    expect(encoded.durationSec).toBeCloseTo(8, 0);
  }, 60_000);

  it("hosts an oversized file once for Reel, Short and TikTok, then cleans up the compressed file and remote object", async () => {
    const large = join(dir, "large.mp4");
    writeFileSync(large, readFileSync(src));
    // Valid media with trailing padding reproduces a file larger than the real KV limit.
    truncateSync(large, KvHosting.MAX_BYTES + 1);
    const before = hash(large);
    let uploaded = "";
    const kv = {
      put: vi.fn(async (path: string) => {
        uploaded = path;
        const info = await probe(path);
        expect(info.sizeBytes).toBeLessThanOrEqual(KvHosting.MAX_BYTES);
        expect(info.durationSec).toBeCloseTo(8, 0);
        return { key: "temporary", url: "https://temporary/video" };
      }),
      remove: vi.fn(async () => {}),
    };
    const notes: string[] = [];
    const host = new SizeLimitedHosting(kv, null, (note) => notes.push(note));
    const { results, hostedKeys } = await executeTasks("run", "file", ["instagram", "youtube", "tiktok"].map((platform) => ({
      platform: platform as "instagram" | "youtube" | "tiktok", surface: platform === "youtube" ? "short" : "feed",
      provider: "test", format: "video", mediaPath: large, needsUrl: true,
      run: async ({ url }: { url?: string }) => {
        expect(url).toBe("https://temporary/video");
        return { status: "confirmed" as const };
      },
    })), { mayPublish: async () => ({ allowed: true, reason: null }), record: async () => {}, host: (path) => host.put(path) });
    expect(results.map((r) => r.status)).toEqual(["confirmed", "confirmed", "confirmed"]);
    expect(kv.put).toHaveBeenCalledTimes(1);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("full duration retained");
    expect(uploaded).not.toBe(large);
    expect(existsSync(uploaded)).toBe(false);
    expect(hash(large)).toBe(before);
    for (const key of hostedKeys) await host.remove(key);
    expect(kv.remove).toHaveBeenCalledWith("temporary");
  }, 60_000);

  it("uses original small files and keeps the optional R2 route for oversized originals", async () => {
    const small = join(dir, "tiny.mp4");
    const large = join(dir, "r2.mp4");
    writeFileSync(small, "small");
    writeFileSync(large, "");
    truncateSync(large, KvHosting.MAX_BYTES + 1);
    const kv = { put: vi.fn(async () => ({ key: "kv", url: "https://kv" })), remove: vi.fn(async () => {}) };
    const r2 = { put: vi.fn(async () => ({ key: "r2", url: "https://r2" })), remove: vi.fn(async () => {}) };
    const host = new SizeLimitedHosting(kv, r2);
    await host.put(small);
    await host.put(large);
    expect(kv.put).toHaveBeenCalledWith(small);
    expect(r2.put).toHaveBeenCalledWith(large);
    await host.remove("kv");
    await host.remove("r2");
    expect(kv.remove).toHaveBeenCalledWith("kv");
    expect(r2.remove).toHaveBeenCalledWith("r2");
  });
});

describe("destination-specific retries", () => {
  const rows = [
    { id: 1, file_id: "f", platform: "instagram", surface: "feed", status: "failed" as const },
    { id: 2, file_id: "f", platform: "youtube", surface: "short", status: "failed" as const },
    { id: 3, file_id: "f", platform: "youtube", surface: "video", status: "failed" as const },
    { id: 4, file_id: "f", platform: "instagram", surface: "story", status: "confirmed" as const },
  ];
  it("can recover the Reel and Short without resending the regular YouTube video or Story", () => {
    expect(selectRetryPublications(rows, rows, "instagram/feed,youtube/short").map((p) => p.id)).toEqual([1, 2]);
  });
  it("rejects unknown, confirmed, pending, or superseded destinations instead of broadening the retry", () => {
    for (const key of ["instagram/story", "youtube/shrot"]) expect(() => selectRetryPublications(rows, rows, key)).toThrow(/Cannot retry/);
    const newer = { ...rows[0], id: 5, status: "processing" as const };
    expect(() => selectRetryPublications(rows, [...rows, newer], "instagram/feed")).toThrow(/Cannot retry/);
  });
});
