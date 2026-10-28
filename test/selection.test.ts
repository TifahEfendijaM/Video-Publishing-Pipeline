import { describe, expect, it } from "vitest";
import { effectiveOutro, orderVideos, resolveCustomName, selectVideo, type FolderVideo } from "../src/shared/selection";

const v = (id: string, name: string, created: string): FolderVideo => ({
  id,
  name,
  mimeType: "video/mp4",
  sizeBytes: 1000,
  md5: `md5-${id}`,
  createdTime: created,
  modifiedTime: created,
});
// Names and modification times deliberately disagree with upload/creation dates.
const videos = [
  v("idC", "a-first-alphabetically.mp4", "2020-01-01T00:00:00Z"),
  v("idA", "zebra.mp4", "2026-09-18T19:21:00Z"),
  v("idB", "middle.mp4", "2026-09-18T19:21:00Z"),
];

describe("folder-only selection", () => {
  it("FIFO/LIFO orders by Drive upload date, with a stable file-ID tie-breaker", () => {
    expect(orderVideos(videos, "fifo").map((x) => x.id)).toEqual(["idC", "idA", "idB"]);
    expect(orderVideos(videos, "lifo").map((x) => x.id)).toEqual(["idA", "idB", "idC"]);
    const renamed = videos.map((x) => ({ ...x, name: "renamed.mp4", modifiedTime: "2030-01-01T00:00:00Z" }));
    expect(selectVideo({ policy: "fifo", videos: renamed }).video?.id).toBe("idC");
  });

  it("advances using remaining source files without any publication history", () => {
    expect(selectVideo({ policy: "fifo", videos }).video?.id).toBe("idC");
    expect(selectVideo({ policy: "fifo", videos: videos.filter((v) => v.id !== "idC") }).video?.id).toBe("idA");
  });

  it("reports exhaustion for all automatic policies", () => {
    for (const policy of ["fifo", "lifo", "random"] as const) {
      const r = selectVideo({ policy, videos: [] });
      expect(r.video).toBeNull();
      expect(r.eligibleCount).toBe(0);
    }
  });

  it("ignores non-video files", () => {
    const withDoc = [...videos, { ...v("idD", "notes.pdf", "2000-01-01T00:00:00Z"), mimeType: "application/pdf" }];
    expect(selectVideo({ policy: "fifo", videos: withDoc }).video?.id).not.toBe("idD");
  });

  it("random can select each eligible file, excluding outros and pending uploads", () => {
    const input = [...videos, v("outro", "outro.mp4", "2000-01-01T00:00:00Z"), v("saved", "ending.mp4", "2001-01-01T00:00:00Z")];
    for (const [draw, id] of [[0, "idC"], [0.5, "idB"], [0.99999, "idB"]] as const) {
      const r = selectVideo({ policy: "random", videos: input, excludeIds: new Set(["saved"]), blockedIds: new Set(["idA"]), random: () => draw });
      expect(r.video?.id).toBe(id);
      expect(r.eligibleCount).toBe(2);
    }
  });

  it("custom overrides random once, and a missing custom falls back to random", () => {
    expect(selectVideo({ policy: "random", videos, customName: "zebra.mp4", random: () => 0 }).video?.id).toBe("idA");
    const r = selectVideo({ policy: "random", videos, customName: "missing.mp4", random: () => 0.9 });
    expect(r.method).toBe("random");
    expect(r.video?.id).toBe("idB");
    expect(r.fallback).toMatch(/RANDOM/);
  });
});

describe("custom selection", () => {
  it("matches the exact full filename including extension", () => {
    const r = selectVideo({ policy: "fifo", customName: "zebra.mp4", videos });
    expect(r.method).toBe("custom");
    expect(r.video!.id).toBe("idA");
    expect(r.fallback).toBeNull();
  });

  it("filename without extension is not an exact match", () => {
    expect(resolveCustomName("zebra", videos).kind).toBe("not_found");
  });

  it("blank falls back to the saved policy and says so", () => {
    const r = selectVideo({ policy: "lifo", customName: "  ", videos });
    expect(r.method).toBe("lifo");
    expect(r.video!.id).toBe("idA");
    expect(r.fallback).toMatch(/empty/);
  });

  it("missing falls back and says so", () => {
    const r = selectVideo({ policy: "fifo", customName: "nope.mp4", videos });
    expect(r.method).toBe("fifo");
    expect(r.fallback).toMatch(/No video named "nope.mp4"/);
  });

  it("duplicate names are ambiguous, never chosen arbitrarily", () => {
    const dup = [...videos, v("idZ", "zebra.mp4", "2026-09-19T00:00:00Z")];
    const r = selectVideo({ policy: "fifo", customName: "zebra.mp4", videos: dup });
    expect(r.method).toBe("fifo");
    expect(r.fallback).toMatch(/2 videos .* ambiguous/);
  });

  it("cannot bypass pending publication checkpoints with custom or scheduled overrides", () => {
    const blockedIds = new Set(["idA"]);
    expect(selectVideo({ policy: "fifo", videos, blockedIds }).video!.id).toBe("idC");
    for (const choice of [{ customName: "zebra.mp4" }, { pendingCustomFileId: "idA" }]) {
      const r = selectVideo({ policy: "fifo", videos, blockedIds, ...choice });
      expect(r.video).toBeNull();
      expect(r.notes.join()).toMatch(/recovery tools/);
    }
  });

  it("pending custom override that left the folder falls back", () => {
    const r = selectVideo({ policy: "fifo", pendingCustomFileId: "gone123456", pendingCustomFileName: "old.mp4", videos });
    expect(r.method).toBe("fifo");
    expect(r.video!.id).toBe("idC");
    expect(r.fallback).toMatch(/no longer in the folder/);
  });

  it("pending custom override present is used", () => {
    const r = selectVideo({ policy: "fifo", pendingCustomFileId: "idC", pendingCustomFileName: "a-first-alphabetically.mp4", videos });
    expect(r.method).toBe("custom");
    expect(r.video!.id).toBe("idC");
  });
});

describe("outro clips", () => {
  const vids = [v("idO", "EasyBosnian outro youtube.mp4", "2000-01-01T00:00:00Z"), v("idX", "special_end_clip.mp4", "2001-01-01T00:00:00Z"), ...videos];
  it("are never picked automatically (by name or by configured ID), but custom may pick them", () => {
    const r = selectVideo({ policy: "fifo", videos: vids, excludeIds: new Set(["idX"]) });
    expect(r.video!.id).not.toBe("idO");
    expect(r.video!.id).not.toBe("idX");
    expect(r.eligibleCount).toBe(3);
    expect(r.notes.join()).toMatch(/2 outro clip/);
    expect(selectVideo({ policy: "fifo", customName: "special_end_clip.mp4", videos: vids, excludeIds: new Set(["idX"]) }).video!.id).toBe("idX");
  });
});

describe("default outro", () => {
  const vids = [v("idO", "outro", "2026-10-07T10:34:44Z"), v("idT", "outro tiktok", "2026-10-07T10:35:00Z"), ...videos];
  it("uses the saved clip, else the default 'outro' clip; an explicit 'none' wins over the default", () => {
    expect(effectiveOutro(undefined, vids, "outro")).toEqual({ fileId: "idO", fileName: "outro", source: "default" });
    expect(effectiveOutro({ fileId: "idT", fileName: "outro tiktok" }, vids, "outro")!.fileId).toBe("idT");
    expect(effectiveOutro(null, vids, "outro")).toBeNull();
    expect(effectiveOutro(undefined, videos, "outro")).toBeNull(); // default clip missing → no outro
    expect(effectiveOutro(undefined, vids, "")).toBeNull();
  });
});
