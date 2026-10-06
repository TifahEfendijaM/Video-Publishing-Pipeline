import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, statSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTasks, buildTasks, anyMayBeLive, type Task, type Identities } from "../runner/src/publish";
import { AmbiguousOutcome, SafeFailure } from "../src/shared/status";
import { redact, registerSecret } from "../src/shared/redact";
import { makeCaptions } from "../runner/src/captioner";
import { encrypt, decrypt } from "../runner/src/google";
import { probe, renderStory, parseProbe } from "../runner/src/media-tools";
import { planFeed, planStory, storySegments } from "../src/shared/media";
import { loadConfig } from "../runner/src/config";
import { Summary } from "../runner/src/summary";

const ok = async () => ({ allowed: true, reason: null });

function task(platform: any, surface: string, run: Task["run"], extra: Partial<Task> = {}): Task {
  return { platform, surface, provider: "p", format: "f", needsUrl: false, run, ...extra };
}

describe("executeTasks", () => {
  it("attempts every destination independently; one failure does not stop others", async () => {
    const record = vi.fn(async () => {});
    const tasks = [
      task("facebook", "feed", async () => {
        throw new SafeFailure("boom");
      }),
      task("instagram", "feed", async () => ({ status: "confirmed", url: "https://instagram.com/p/x" })),
      task("tiktok", "feed", async () => {
        throw new Error("unexpected");
      }),
      task("youtube", "feed", async () => ({ status: "confirmed", url: "https://youtu.be/x" })),
    ];
    const { results } = await executeTasks("run1", "file1", tasks, { mayPublish: ok, record });
    expect(results.map((r) => r.status)).toEqual(["failed", "confirmed", "failed", "confirmed"]);
    expect(anyMayBeLive(results)).toBe(true);
  });

  it("ambiguous outcomes become 'uncertain' and are never retried", async () => {
    let calls = 0;
    const tasks = [
      task("instagram", "feed", async (c) => {
        calls++;
        await c.progress("processing", "container1");
        throw new AmbiguousOutcome("lost response");
      }),
    ];
    const { results } = await executeTasks("r", "f", tasks, { mayPublish: ok, record: async () => {} });
    expect(results[0].status).toBe("uncertain");
    expect(results[0].remoteId).toBe("container1");
    expect(calls).toBe(1);
  });

  it("unknown error after the provider made progress is uncertain, not failed", async () => {
    const tasks = [
      task("facebook", "feed", async (c) => {
        await c.progress("processing", "vid1");
        throw new Error("socket hang up");
      }),
    ];
    const { results } = await executeTasks("r", "f", tasks, { mayPublish: ok, record: async () => {} });
    expect(results[0].status).toBe("uncertain");
  });

  it("kill switch / stale state stops all remaining publications and fails closed", async () => {
    const run = vi.fn(async () => ({ status: "confirmed" as const }));
    let n = 0;
    const mayPublish = async () => (++n === 1 ? { allowed: true, reason: null } : { allowed: false, reason: "Global publishing kill switch is OFF." });
    const { results } = await executeTasks("r", "f", [task("instagram", "feed", run), task("facebook", "feed", run), task("youtube", "feed", run)], { mayPublish, record: async () => {} });
    expect(results.map((r) => r.status)).toEqual(["confirmed", "disabled", "disabled"]);
    expect(run).toHaveBeenCalledTimes(1);
    const broken = await executeTasks("r", "f", [task("instagram", "feed", run)], {
      mayPublish: async () => {
        throw new Error("worker down");
      },
      record: async () => {},
    });
    expect(broken.results[0].status).toBe("disabled");
    expect(broken.results[0].detail).toMatch(/failing closed/);
    expect(anyMayBeLive(broken.results)).toBe(false);
  });

  it("records blocked tasks and hosting failures without throwing", async () => {
    const recorded: any[] = [];
    const tasks = [
      task("tiktok", "story", undefined, { blocked: { status: "unsupported", detail: "no API" } }),
      task("instagram", "feed", async () => ({ status: "confirmed" }), { needsUrl: true, mediaPath: "/x.mp4" }),
    ];
    const { results } = await executeTasks("r", "f", tasks, {
      mayPublish: ok,
      record: async (r) => void recorded.push(r),
      host: async () => {
        throw new Error("R2 down");
      },
    });
    expect(results.map((r) => r.status)).toEqual(["unsupported", "failed"]);
    expect(results[1].detail).toMatch(/temporary hosting failed/);
    expect(recorded.at(-1)).toMatchObject({ runId: "r", fileId: "f", platform: "instagram" });
  });

  it("hosts each media file once and reports keys for cleanup", async () => {
    const host = vi.fn(async (p: string) => ({ key: `k-${p}`, url: `https://signed/${p}` }));
    const urls: string[] = [];
    const t = (s: string, p: string) => task("instagram", s, async (c) => (urls.push(c.url!), { status: "confirmed" as const }), { needsUrl: true, mediaPath: p });
    const { hostedKeys } = await executeTasks("r", "f", [t("feed", "/a"), t("story", "/b"), task("tiktok", "feed", async (c) => (urls.push(c.url!), { status: "confirmed" }), { needsUrl: true, mediaPath: "/a" })], { mayPublish: ok, record: async () => {}, host });
    expect(host).toHaveBeenCalledTimes(2);
    expect(hostedKeys.sort()).toEqual(["k-/a", "k-/b"]);
    expect(urls).toEqual(["https://signed//a", "https://signed//b", "https://signed//a"]);
  });
});

describe("buildTasks routing", () => {
  const cfg = loadConfig();
  const horizontal = { durationSec: 8, width: 1280, height: 720, videoCodec: "h264", audioCodec: "aac", audioSampleRate: 48000, fps: 24, sizeBytes: 2e6, container: "mov,mp4", pixFmt: "yuv420p" };
  const vertical = { ...horizontal, width: 1080, height: 1920 };
  const allOk: Identities = { instagram: { ok: true, detail: "" }, facebook: { ok: true, detail: "" }, tiktok: { ok: true, detail: "" }, youtube: { ok: true, detail: "" }, youtubeBuffer: { ok: true, detail: "" } };
  const fakeProviders = { meta: {} as any, buffer: {} as any, youtube: {} as any };
  const caps = { caption: "x", youtubeTitle: "t", youtubeDescription: "d" };
  const build = (info: any, c = cfg, ids = allOk) =>
    buildTasks({ cfg: c, info, feed: planFeed(info), stories: { plan: planStory(info, c.stories.longVideoPolicy), files: [] }, originalPath: "/o.mp4", captions: caps, providers: fakeProviders, identities: ids });

  it("TikTok Story is always marked unsupported/manual, feed is via Buffer", () => {
    const t = build(vertical);
    expect(t.find((x) => x.platform === "tiktok" && x.surface === "story")!.blocked!.status).toBe("unsupported");
    expect(t.find((x) => x.platform === "tiktok" && x.surface === "feed")!.provider).toBe("buffer");
  });

  it("YouTube unaudited + not a Short → uploaded PRIVATE for manual publishing (never cropped); or manual if private upload is off", () => {
    const y = build(horizontal).find((x) => x.platform === "youtube")!;
    expect(y.provider).toBe("youtube_data_api");
    expect(y.format).toBe("video");
    const c = structuredClone(cfg);
    c.destinations.youtube.uploadPrivateWhenUnaudited = false;
    const m = build(horizontal, c).find((x) => x.platform === "youtube")!;
    expect(m.blocked!.status).toBe("unsupported");
    expect(m.blocked!.detail).toMatch(/Buffer only publishes YouTube Shorts/);
  });

  it("YouTube: Shorts-eligible + Buffer YouTube channel → Buffer (public); audited → official API", () => {
    const c1 = structuredClone(cfg);
    c1.destinations.youtube.bufferChannelId = "chan";
    expect(build(vertical, c1).find((x) => x.platform === "youtube")!.provider).toBe("buffer");
    expect(build(horizontal, c1).find((x) => x.platform === "youtube")!.provider).toBe("youtube_data_api");
    const c2 = structuredClone(cfg);
    c2.destinations.youtube.apiProjectAudited = true;
    expect(build(horizontal, c2).find((x) => x.platform === "youtube")!.provider).toBe("youtube_data_api");
  });

  it("unverified identity disables the destination", () => {
    const ids = { ...allOk, instagram: { ok: false, detail: "linked Instagram is @someone_else" } };
    const ig = build(vertical, cfg, ids).filter((x) => x.platform === "instagram");
    expect(ig.every((x) => x.blocked?.status === "disabled")).toBe(true);
  });

  it("Facebook uses a Reel for 9:16 and a regular Page video otherwise; Stories exist for IG and FB", () => {
    expect(build(vertical).find((x) => x.platform === "facebook" && x.surface === "feed")!.format).toBe("reel");
    expect(build(horizontal).find((x) => x.platform === "facebook" && x.surface === "feed")!.format).toBe("page_video");
    const s = build(horizontal).filter((x) => x.format === "story" && x.platform !== "tiktok");
    expect(s.map((x) => x.platform)).toEqual(["instagram", "facebook"]);
  });

  it("long video: segmentation is now enabled by config; without it, Stories are reported and feed still attempted", () => {
    expect(cfg.stories.longVideoPolicy).toBe("segment");
    const c = structuredClone(cfg);
    c.stories.longVideoPolicy = "skip";
    const t = build({ ...vertical, durationSec: 95 }, c);
    expect(t.filter((x) => x.format === "story" && x.platform !== "tiktok").every((x) => x.blocked?.status === "unsupported")).toBe(true);
    expect(t.find((x) => x.platform === "instagram" && x.surface === "feed")!.blocked).toBeUndefined();
  });

  it("segmented Stories get separately identifiable surfaces per platform", () => {
    const info = { ...vertical, durationSec: 95 };
    const plan = planStory(info, "segment");
    const files = plan.kind === "segmented" ? plan.segments.map((sg) => ({ path: `/s${sg.index}.mp4`, surface: `story_part_${sg.index}`, label: "" })) : [];
    const t = buildTasks({ cfg, info, feed: planFeed(info), stories: { plan, files }, originalPath: "/o.mp4", captions: caps, providers: fakeProviders, identities: allOk });
    expect(t.filter((x) => x.platform === "instagram" && x.format === "story").map((x) => x.surface)).toEqual(["story_part_1", "story_part_2"]);
    expect(t.filter((x) => x.platform === "facebook" && x.format === "story").map((x) => x.surface)).toEqual(["story_part_1", "story_part_2"]);
  });
});

describe("secret redaction", () => {
  it("removes tokens, signed URLs and registered secret values", () => {
    registerSecret("super-secret-refresh-value");
    const text = [
      "Authorization: Bearer EAAGm0PX4ZCpsBAKZCZBabcdefghijklmnop",
      "https://graph.facebook.com/v24.0/me?access_token=EAAB123456789012345678901234&fields=id",
      "ya29.a0AfH6SMBxyz-abc",
      "refresh 1//0gAbCdEfGhIjKlMnOpQrStUvWxYz",
      "key sk-ant-api03-abcdef",
      "https://acc.r2.cloudflarestorage.com/bucket/tmp/x.mp4?X-Amz-Signature=deadbeef",
      '{"refresh_token":"abc","claim_token":"zzz"}',
      "github_pat_11ABCDEFG_abcdef",
      "value super-secret-refresh-value here",
    ].join("\n");
    const out = redact(text);
    for (const leak of ["EAAGm0PX4", "EAAB1234", "ya29.a0", "1//0gAb", "sk-ant-api03", "deadbeef", '"abc"', '"zzz"', "github_pat_11", "super-secret-refresh-value"]) {
      expect(out).not.toContain(leak);
    }
  });

  it("summary output is redacted and escaped", () => {
    registerSecret("tok_ABCDEFGH");
    const s = new Summary().p("token tok_ABCDEFGH <script>").table(["a"], [["x|y"]]);
    expect(s.text()).not.toContain("tok_ABCDEFGH");
    expect(s.text()).toContain("&lt;script&gt;");
    expect(s.text()).toContain("x\\|y");
  });

  it("rotated credentials round-trip through AES-GCM and are not stored in plaintext", () => {
    const key = Buffer.alloc(32, 7).toString("base64");
    const ct = encrypt(key, "1//refresh-token");
    expect(ct).not.toContain("refresh");
    expect(decrypt(key, ct)).toBe("1//refresh-token");
    expect(() => decrypt(Buffer.alloc(32, 8).toString("base64"), ct)).toThrow();
  });
});

describe("captions (free Cloudflare Workers AI model, injectable for tests)", () => {
  const good = {
    topic_caption: "Naručiti kafu u Sarajevu je pravi mali ritual. ☕",
    website_invitation: "Uz EasyBosnian ćeš i za šankom zvučati kao domaći!",
    youtube_title: "Kako naručiti kafu na bosanskom",
    youtube_description: "Kratko o tome kako se naručuje kafa. Uči bosanski uz EasyBosnian.",
  };

  it("meaningless filenames use the stored generic caption with no model call", async () => {
    let called = false;
    const r = await makeCaptions("gemini_generated_video_0A28F2A0.mp4", { model: "m", run: async () => ((called = true), good) });
    expect(r.source).toBe("generic");
    expect(called).toBe(false);
    expect(r.caption.endsWith("👉easybosnian.com")).toBe(true);
    expect(r.caption).toContain("Želiš");
  });

  it("meaningful filename without a configured model falls back to generic and says so", async () => {
    const r = await makeCaptions("kako_naruciti_kafu.mp4", { model: "m" });
    expect(r.analysis.meaningful).toBe(true);
    expect(r.source).toBe("generic");
    expect(r.notes.join()).toMatch(/Workers AI/);
  });

  it("valid model output becomes a topic caption ending with the exact website line", async () => {
    let prompt = "";
    const r = await makeCaptions("kako_naruciti_kafu.mp4", { model: "m", run: async (_s, u) => ((prompt = u), good) });
    expect(r.source).toBe("generated");
    expect(r.caption).toBe(`${good.topic_caption}\n${good.website_invitation}\n👉easybosnian.com`);
    expect(r.caption).toMatch(/[čćšž]/);
    expect(prompt).toContain('"kako naruciti kafu"'); // filename passed as quoted data
  });

  it("rejects bad output (no diacritics, CEFR, English, Cyrillic, foreign link) and retries once, then falls back", async () => {
    const bad = [
      { ...good, topic_caption: "Nauci kako naruciti kafu.", website_invitation: "Uci bosanski uz EasyBosnian.", youtube_description: "Kafa. Uci bosanski." },
      { ...good, topic_caption: "Lekcija za nivo A2: learn with us at evil.com" },
    ];
    let n = 0;
    const r = await makeCaptions("kako_naruciti_kafu.mp4", { model: "m", run: async () => bad[n++] });
    expect(n).toBe(2);
    expect(r.source).toBe("generic");
    expect(r.notes.join(" ")).toMatch(/diacritics/);
    expect(r.notes.join(" ")).toMatch(/CEFR/);
    expect(r.notes.join(" ")).toMatch(/safe fallback/);
  });

  it("model errors (e.g. free allowance used up) fall back without failing the run", async () => {
    const r = await makeCaptions("kako_naruciti_kafu.mp4", { model: "m", run: async () => { throw new Error("HTTP 429 daily free allocation exceeded"); } });
    expect(r.source).toBe("generic");
    expect(r.notes.join()).toMatch(/nothing is charged/);
  });
});

describe("ffprobe / ffmpeg", () => {
  const dir = mkdtempSync(join(tmpdir(), "ebv-test-"));
  const src = join(dir, "h.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=24:duration=8", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=8", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", src]);

  it("probes real media properties", async () => {
    const info = await probe(src);
    expect(info).toMatchObject({ width: 1280, height: 720, videoCodec: "h264", audioCodec: "aac", fps: 24 });
    expect(info.durationSec).toBeGreaterThan(7.9);
  });

  it("applies rotation metadata to display dimensions", () => {
    const info = parseProbe({ format: { duration: "5", format_name: "mov,mp4" }, streams: [{ codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "30/1", side_data_list: [{ rotation: -90 }] }] }, 1);
    expect([info.width, info.height]).toEqual([1080, 1920]);
  });

  it("Story rendition letterboxes the complete frame into 1080x1920 and leaves the original untouched", async () => {
    const before = createHash("md5").update(readFileSync(src)).digest("hex");
    const out = join(dir, "story.mp4");
    const info = await probe(src);
    await renderStory(src, out, info);
    const s = await probe(out);
    expect([s.width, s.height]).toEqual([1080, 1920]);
    expect(Math.abs(s.durationSec - info.durationSec)).toBeLessThan(0.2);
    expect(s.audioCodec).toBe("aac");
    // Top band must be black padding (content fitted, not cropped/stretched): sample the first rows.
    const raw = execFileSync("ffmpeg", ["-v", "error", "-i", out, "-frames:v", "1", "-vf", "crop=1080:100:0:0", "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
    expect(Math.max(...raw)).toBeLessThan(30);
    expect(createHash("md5").update(readFileSync(src)).digest("hex")).toBe(before);
    expect(statSync(src).size).toBeGreaterThan(0);
  }, 60_000);

  it("segment rendition covers the requested time range", async () => {
    const info = await probe(src);
    const seg = storySegments(8, 4)[1];
    const out = join(dir, "seg2.mp4");
    await renderStory(src, out, info, seg);
    const s = await probe(out);
    expect(Math.abs(s.durationSec - 4)).toBeLessThan(0.2);
  }, 60_000);
});
