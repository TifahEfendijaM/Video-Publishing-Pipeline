// Media compatibility planning. Pure logic: input is the ffprobe-derived summary of the ORIGINAL file.
// Nothing here cuts, crops or reshapes a feed video. Story renditions only letterbox the complete video
// onto a 9:16 canvas; long Stories are segmented only if the owner has explicitly opted in.

export interface MediaInfo {
  durationSec: number;
  width: number; // display width (rotation applied)
  height: number; // display height (rotation applied)
  videoCodec: string; // e.g. "h264", "hevc"
  audioCodec: string | null; // null = no audio stream
  audioSampleRate: number | null;
  fps: number;
  sizeBytes: number;
  container: string; // ffprobe format_name, e.g. "mov,mp4,m4a,3gp,3g2,mj2"
  pixFmt: string | null;
}

export type LongStoryPolicy = "skip" | "segment";

export interface Check {
  ok: boolean;
  problems: string[];
}

export const STORY_MAX_SEC = 60;
export const STORY_MIN_SEC = 3;
export const STORY_CANVAS = { width: 1080, height: 1920 } as const;

const MP4ISH = (c: string) => /mp4|mov|quicktime/.test(c);
const H26X = (c: string) => c === "h264" || c === "hevc";

export function aspect(m: MediaInfo): number {
  return m.width / m.height;
}
export function isVertical916(m: MediaInfo, tolerance = 0.02): boolean {
  return Math.abs(aspect(m) - 9 / 16) <= tolerance;
}
export function isPortraitOrSquare(m: MediaInfo): boolean {
  return m.height >= m.width;
}

function check(problems: string[]): Check {
  return { ok: problems.length === 0, problems };
}

// Instagram Reels (Graph API, REELS): MP4/MOV, H.264/HEVC, AAC (optional), 3 s – 15 min, ≤ 300 MB,
// 23–60 fps, width ≤ 1920. Non-9:16 aspect ratios are accepted (displayed with bars in the Reels tab).
export function instagramReelCheck(m: MediaInfo): Check {
  const p: string[] = [];
  if (!MP4ISH(m.container)) p.push(`container ${m.container} is not MP4/MOV`);
  if (!H26X(m.videoCodec)) p.push(`video codec ${m.videoCodec} is not H.264/HEVC`);
  if (m.audioCodec && m.audioCodec !== "aac") p.push(`audio codec ${m.audioCodec} is not AAC`);
  if (m.durationSec < 3) p.push(`duration ${m.durationSec.toFixed(1)} s is below 3 s`);
  if (m.durationSec > 900) p.push(`duration ${m.durationSec.toFixed(0)} s exceeds 15 min`);
  if (m.sizeBytes > 300 * 1024 * 1024) p.push("file exceeds 300 MB");
  if (m.fps < 23 || m.fps > 60) p.push(`frame rate ${m.fps.toFixed(2)} is outside 23–60 fps`);
  if (m.width > 1920) p.push(`width ${m.width} exceeds 1920 px`);
  return check(p);
}

// Facebook Page Reels (video_reels): 9:16, ≥ 540x960, 3–90 s, H.264/H.265, AAC. Other sources go to a regular Page video.
export function facebookReelCheck(m: MediaInfo): Check {
  const p: string[] = [];
  if (!isVertical916(m)) p.push(`aspect ratio ${m.width}x${m.height} is not 9:16`);
  if (m.width < 540 || m.height < 960) p.push("resolution below 540x960");
  if (m.durationSec < 3 || m.durationSec > 90) p.push(`duration ${m.durationSec.toFixed(1)} s is outside 3–90 s`);
  if (!H26X(m.videoCodec)) p.push(`video codec ${m.videoCodec} is not H.264/H.265`);
  if (m.fps < 24 || m.fps > 60) p.push(`frame rate ${m.fps.toFixed(2)} is outside 24–60 fps`);
  return check(p);
}

// Facebook regular Page video (resumable /videos upload): broad support; we still require a sane container/codec.
export function facebookPageVideoCheck(m: MediaInfo): Check {
  const p: string[] = [];
  if (!MP4ISH(m.container)) p.push(`container ${m.container} is not MP4/MOV`);
  if (m.sizeBytes > 10 * 1024 * 1024 * 1024) p.push("file exceeds 10 GB");
  if (m.durationSec > 240 * 60) p.push("duration exceeds 240 min");
  return check(p);
}

// TikTok video post (via Buffer): MP4/MOV/WebM, 3 s – 10 min, H.264/HEVC.
export function tiktokCheck(m: MediaInfo): Check {
  const p: string[] = [];
  if (!/mp4|mov|quicktime|webm/.test(m.container)) p.push(`container ${m.container} not supported`);
  if (!H26X(m.videoCodec) && m.videoCodec !== "vp8" && m.videoCodec !== "vp9") p.push(`video codec ${m.videoCodec} not supported`);
  if (m.durationSec < 3) p.push(`duration ${m.durationSec.toFixed(1)} s is below 3 s`);
  if (m.durationSec > 600) p.push(`duration ${m.durationSec.toFixed(0)} s exceeds 10 min`);
  if (m.sizeBytes > 1024 * 1024 * 1024) p.push("file exceeds 1 GB");
  if (m.height < 360 || m.width < 360) p.push("resolution below 360 px");
  return check(p);
}

// YouTube Shorts: ≤ 3 min AND square or vertical. Anything else is a regular (long-form) upload.
export function qualifiesAsShort(m: MediaInfo): boolean {
  return m.durationSec <= 180 && isPortraitOrSquare(m);
}

export interface StorySegment {
  index: number; // 1-based
  count: number;
  startSec: number;
  durationSec: number;
}

/** Chronological, equal-length segments of at most maxSec each (no segment shorter than STORY_MIN_SEC unless the video is). */
export function storySegments(durationSec: number, maxSec = STORY_MAX_SEC): StorySegment[] {
  const count = Math.max(1, Math.ceil(durationSec / maxSec - 1e-9));
  const len = durationSec / count;
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  const starts = Array.from({ length: count }, (_, i) => r3(i * len));
  return starts.map((start, i) => ({
    index: i + 1,
    count,
    startSec: start,
    durationSec: r3((i === count - 1 ? durationSec : starts[i + 1]) - start),
  }));
}

export type StoryPlan =
  | { kind: "none"; reason: string }
  | { kind: "single"; needsRendition: boolean; renditionReason: string | null }
  | { kind: "segmented"; segments: StorySegment[]; renditionReason: string }
  | { kind: "needs_decision"; reason: string };

export function planStory(m: MediaInfo, policy: LongStoryPolicy): StoryPlan {
  if (m.durationSec < STORY_MIN_SEC) return { kind: "none", reason: `video is ${m.durationSec.toFixed(1)} s; Stories need at least ${STORY_MIN_SEC} s` };
  const reasons: string[] = [];
  if (!isVertical916(m)) reasons.push(`source is ${m.width}x${m.height}; the complete frame is letterboxed onto a 1080x1920 canvas (no crop, no stretch)`);
  else if (m.width > 1920 || m.height > 1920) reasons.push("source exceeds 1920 px; scaled down without cropping");
  if (!H26X(m.videoCodec) || !MP4ISH(m.container)) reasons.push("re-encoded to H.264/MP4 for Story upload");
  if (m.audioCodec && m.audioCodec !== "aac") reasons.push("audio re-encoded to AAC");
  if (m.fps > 60) reasons.push("frame rate reduced to 60 fps");
  if (m.durationSec <= STORY_MAX_SEC) {
    return { kind: "single", needsRendition: reasons.length > 0, renditionReason: reasons.length ? reasons.join("; ") : null };
  }
  if (policy === "segment") {
    const segs = storySegments(m.durationSec);
    return {
      kind: "segmented",
      segments: segs,
      renditionReason: [`video is ${m.durationSec.toFixed(1)} s; split chronologically into ${segs.length} consecutive Stories covering the full duration`, ...reasons].join("; "),
    };
  }
  return {
    kind: "needs_decision",
    reason: `video is ${m.durationSec.toFixed(1)} s, longer than the ${STORY_MAX_SEC} s Story limit; segmentation is not enabled (stories.longVideoPolicy = "skip"), so no Story was posted and nothing was discarded`,
  };
}

export interface FeedPlan {
  instagram: { format: "reel"; check: Check };
  facebook: { format: "reel" | "page_video"; check: Check; reason: string };
  tiktok: { format: "video"; check: Check };
  youtube: { format: "short" | "video"; reason: string };
}

export function planFeed(m: MediaInfo): FeedPlan {
  const fbReel = facebookReelCheck(m);
  const fb = fbReel.ok
    ? { format: "reel" as const, check: fbReel, reason: "9:16, 3–90 s: published as a Facebook Reel" }
    : {
        format: "page_video" as const,
        check: facebookPageVideoCheck(m),
        reason: `not Reel-eligible (${fbReel.problems.join("; ")}): published unchanged as a regular Page video`,
      };
  const short = qualifiesAsShort(m);
  return {
    instagram: { format: "reel", check: instagramReelCheck(m) },
    facebook: fb,
    tiktok: { format: "video", check: tiktokCheck(m) },
    youtube: {
      format: short ? "short" : "video",
      reason: short
        ? "≤ 3 min and square/vertical: YouTube classifies it as a Short"
        : `${isPortraitOrSquare(m) ? "longer than 3 min" : `horizontal ${m.width}x${m.height}`}: regular YouTube video (not a Short; the video is not cropped to make it one)`,
    },
  };
}

// ---------------------------------------------------------------------------
// YouTube: owner requested BOTH a Short and a regular video for every clip.
// YouTube classifies an upload as a Short when it is vertical/square and <= 3 min, so:
//  - the Short is the original if it already qualifies, otherwise the complete frame letterboxed to 1080x1920;
//  - the regular video is the original if it is not Short-shaped, otherwise the complete frame pillarboxed
//    onto a 1920x1080 widescreen canvas (black side bars, nothing cropped or stretched).
export const SHORT_MAX_SEC = 180;
export const WIDESCREEN_CANVAS = { width: 1920, height: 1080 } as const;

export interface YouTubeVersions {
  short: { kind: "original" | "vertical_canvas" | "impossible"; reason: string };
  regular: { kind: "original" | "widescreen_canvas"; reason: string };
}

export function planYouTubeVersions(m: MediaInfo): YouTubeVersions {
  const short: YouTubeVersions["short"] =
    m.durationSec > SHORT_MAX_SEC
      ? { kind: "impossible", reason: `video is ${m.durationSec.toFixed(0)} s; Shorts are limited to 3 min, so no Short is made (nothing is cut)` }
      : isPortraitOrSquare(m)
        ? { kind: "original", reason: "original file already qualifies as a Short (vertical/square, ≤ 3 min)" }
        : { kind: "vertical_canvas", reason: `horizontal ${m.width}x${m.height}: complete frame letterboxed onto a 1080x1920 canvas for the Short (no crop, no stretch)` };
  const regular: YouTubeVersions["regular"] = qualifiesAsShort(m)
    ? { kind: "widescreen_canvas", reason: `${m.width}x${m.height} would be classified as a Short, so the regular video places the complete frame on a 1920x1080 widescreen canvas with black side bars (no crop, no stretch)` }
    : { kind: "original", reason: "original file is already a regular (non-Short) video" };
  return { short, regular };
}
