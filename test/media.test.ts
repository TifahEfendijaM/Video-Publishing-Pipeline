import { describe, expect, it } from "vitest";
import { planFeed, planStory, storySegments, type MediaInfo } from "../src/shared/media";

const base: MediaInfo = {
  durationSec: 8,
  width: 1280,
  height: 720,
  videoCodec: "h264",
  audioCodec: "aac",
  audioSampleRate: 48000,
  fps: 24,
  sizeBytes: 2_656_558,
  container: "mov,mp4,m4a,3gp,3g2,mj2",
  pixFmt: "yuv420p",
};
const vertical: MediaInfo = { ...base, width: 1080, height: 1920 };

describe("feed formats", () => {
  it("horizontal 8 s: IG Reel, FB regular Page video, YouTube regular video (not cropped into a Short)", () => {
    const p = planFeed(base);
    expect(p.instagram.check.ok).toBe(true);
    expect(p.facebook.format).toBe("page_video");
    expect(p.facebook.reason).toMatch(/not Reel-eligible/);
    expect(p.youtube.format).toBe("video");
    expect(p.youtube.reason).toMatch(/not cropped/);
    expect(p.tiktok.check.ok).toBe(true);
  });

  it("vertical 8 s: FB Reel and YouTube Short", () => {
    const p = planFeed(vertical);
    expect(p.facebook.format).toBe("reel");
    expect(p.youtube.format).toBe("short");
  });

  it("vertical 4 min: FB Page video, YouTube regular video", () => {
    const p = planFeed({ ...vertical, durationSec: 240 });
    expect(p.facebook.format).toBe("page_video");
    expect(p.youtube.format).toBe("video");
  });

  it("flags incompatible media instead of silently converting", () => {
    const p = planFeed({ ...base, durationSec: 2, videoCodec: "prores", container: "matroska,webm" });
    expect(p.instagram.check.ok).toBe(false);
    expect(p.instagram.check.problems.join()).toMatch(/below 3 s/);
    expect(p.instagram.check.problems.join()).toMatch(/not H.264/);
    expect(p.tiktok.check.ok).toBe(false);
  });
});

describe("Stories", () => {
  it("horizontal ≤60 s: single Story letterboxed onto 9:16 without cropping", () => {
    const s = planStory(base, "skip");
    expect(s.kind).toBe("single");
    if (s.kind === "single") {
      expect(s.needsRendition).toBe(true);
      expect(s.renditionReason).toMatch(/letterboxed.*no crop, no stretch/);
    }
  });

  it("vertical H.264 ≤60 s needs no rendition", () => {
    const s = planStory(vertical, "skip");
    expect(s).toEqual({ kind: "single", needsRendition: false, renditionReason: null });
  });

  it("over 60 s is NOT posted or truncated unless segmentation was agreed", () => {
    const s = planStory({ ...vertical, durationSec: 95 }, "skip");
    expect(s.kind).toBe("needs_decision");
    if (s.kind === "needs_decision") expect(s.reason).toMatch(/nothing was discarded/);
  });

  it("segmentation (when enabled) is chronological and covers the full duration", () => {
    const segs = storySegments(125);
    expect(segs).toHaveLength(3);
    expect(segs.every((x) => x.durationSec <= 60)).toBe(true);
    const total = segs.reduce((a, x) => a + x.durationSec, 0);
    expect(total).toBeCloseTo(125, 3);
    expect(segs[1].startSec).toBeCloseTo(segs[0].durationSec, 3);
    expect(segs.map((s) => s.index)).toEqual([1, 2, 3]);
    expect(storySegments(61).every((x) => x.durationSec >= 3)).toBe(true);
    expect(storySegments(60)).toHaveLength(1);
    const plan = planStory({ ...vertical, durationSec: 125 }, "segment");
    expect(plan.kind).toBe("segmented");
  });

  it("too short for a Story", () => {
    expect(planStory({ ...base, durationSec: 2 }, "skip").kind).toBe("none");
  });
});
