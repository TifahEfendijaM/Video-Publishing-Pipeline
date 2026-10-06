import { describe, expect, it } from "vitest";
import { orderVideos, rankable, resolveCustomName, selectVideo, type FolderVideo, type VideoRecord } from "../src/shared/selection";

const v = (id: string, name: string, created: string): FolderVideo => ({
  id,
  name,
  mimeType: "video/mp4",
  sizeBytes: 1000,
  md5: `md5-${id}`,
  createdTime: created,
  modifiedTime: created,
});
const rec = (fileId: string, enteredFolderAt: string | null, consumed = false, entrySource: VideoRecord["entrySource"] = "drive_activity"): [string, VideoRecord] => [
  fileId,
  { fileId, enteredFolderAt, entrySource: enteredFolderAt ? entrySource : null, consumed, md5AtPublication: null },
];

// Alphabetical order and created/modified order deliberately disagree with folder-entry order.
const videos = [
  v("idC", "a-first-alphabetically.mp4", "2020-01-01T00:00:00Z"),
  v("idA", "zebra.mp4", "2026-09-18T19:21:00Z"),
  v("idB", "middle.mp4", "2026-09-18T19:21:00Z"),
];
const records = new Map([
  rec("idC", "2026-09-20T10:00:00Z"), // created long ago, MOVED into folder last
  rec("idA", "2026-09-18T19:21:00Z"),
  rec("idB", "2026-09-18T19:21:00Z"), // identical timestamp to idA
]);

describe("FIFO / LIFO ordering", () => {
  it("orders by folder-entry time, not name or createdTime, with file-ID tie-breaker", () => {
    const ranked = rankable(videos, records);
    expect(orderVideos(ranked, "fifo").map((x) => x.id)).toEqual(["idA", "idB", "idC"]);
    expect(orderVideos(ranked, "lifo").map((x) => x.id)).toEqual(["idC", "idA", "idB"]);
  });

  it("labels createdTime fallback as an approximation", () => {
    const ranked = rankable(videos, new Map());
    expect(ranked.every((r) => r.entrySource === "created_time_approximation")).toBe(true);
    const r = selectVideo({ policy: "fifo", videos, records: new Map() });
    expect(r.notes.join(" ")).toMatch(/approximated by Drive createdTime/);
  });

  it("skips videos already published by the pipeline (by file ID) and advances", () => {
    const recs = new Map(records);
    recs.set("idA", { ...recs.get("idA")!, consumed: true });
    expect(selectVideo({ policy: "fifo", videos, records: recs }).video!.id).toBe("idB");
    // a renamed file keeps its identity
    const renamed = videos.map((x) => (x.id === "idA" ? { ...x, name: "renamed.mp4" } : x));
    expect(selectVideo({ policy: "fifo", videos: renamed, records: recs }).video!.id).toBe("idB");
  });

  it("reports exhaustion without restarting", () => {
    const all = new Map([...records].map(([k, r]) => [k, { ...r, consumed: true }]));
    const r = selectVideo({ policy: "lifo", videos, records: all });
    expect(r.video).toBeNull();
    expect(r.eligibleCount).toBe(0);
    expect(selectVideo({ policy: "fifo", videos: [], records: new Map() }).video).toBeNull();
  });

  it("ignores non-video files", () => {
    const withDoc = [...videos, { ...v("idD", "notes.pdf", "2000-01-01T00:00:00Z"), mimeType: "application/pdf" }];
    expect(selectVideo({ policy: "fifo", videos: withDoc, records: new Map() }).video!.id).not.toBe("idD");
  });
});

describe("custom selection", () => {
  it("matches the exact full filename including extension", () => {
    const r = selectVideo({ policy: "fifo", customName: "zebra.mp4", videos, records });
    expect(r.method).toBe("custom");
    expect(r.video!.id).toBe("idA");
    expect(r.fallback).toBeNull();
  });

  it("filename without extension is not an exact match", () => {
    expect(resolveCustomName("zebra", videos).kind).toBe("not_found");
  });

  it("blank falls back to the saved policy and says so", () => {
    const r = selectVideo({ policy: "lifo", customName: "  ", videos, records });
    expect(r.method).toBe("lifo");
    expect(r.video!.id).toBe("idC");
    expect(r.fallback).toMatch(/empty/);
  });

  it("missing falls back and says so", () => {
    const r = selectVideo({ policy: "fifo", customName: "nope.mp4", videos, records });
    expect(r.method).toBe("fifo");
    expect(r.fallback).toMatch(/No video named "nope.mp4"/);
  });

  it("duplicate names are ambiguous, never chosen arbitrarily", () => {
    const dup = [...videos, v("idZ", "zebra.mp4", "2026-09-19T00:00:00Z")];
    const r = selectVideo({ policy: "fifo", customName: "zebra.mp4", videos: dup, records });
    expect(r.method).toBe("fifo");
    expect(r.fallback).toMatch(/2 videos .* ambiguous/);
  });

  it("may deliberately select a previously published video", () => {
    const recs = new Map(records);
    recs.set("idA", { ...recs.get("idA")!, consumed: true });
    const r = selectVideo({ policy: "fifo", customName: "zebra.mp4", videos, records: recs });
    expect(r.video!.id).toBe("idA");
    expect(r.notes.join(" ")).toMatch(/explicitly requested/);
  });

  it("pending custom override that left the folder falls back", () => {
    const r = selectVideo({ policy: "fifo", pendingCustomFileId: "gone123456", pendingCustomFileName: "old.mp4", videos, records });
    expect(r.method).toBe("fifo");
    expect(r.video!.id).toBe("idA");
    expect(r.fallback).toMatch(/no longer in the folder/);
  });

  it("pending custom override present is used", () => {
    const r = selectVideo({ policy: "fifo", pendingCustomFileId: "idC", pendingCustomFileName: "a-first-alphabetically.mp4", videos, records });
    expect(r.method).toBe("custom");
    expect(r.video!.id).toBe("idC");
  });
});
