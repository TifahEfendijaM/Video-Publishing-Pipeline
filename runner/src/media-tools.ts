// ffprobe / ffmpeg wrappers. The original file is never modified.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { statSync } from "node:fs";
import type { MediaInfo, StorySegment } from "../../src/shared/media";
import { STORY_CANVAS } from "../../src/shared/media";

const run = promisify(execFile);

export function parseProbe(probe: any, sizeBytes: number): MediaInfo {
  const v = (probe.streams ?? []).find((s: any) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  if (!v) throw new Error("no video stream found");
  const a = (probe.streams ?? []).find((s: any) => s.codec_type === "audio");
  let rotation = 0;
  const sd = (v.side_data_list ?? []).find((d: any) => d.rotation !== undefined);
  if (sd) rotation = Number(sd.rotation);
  else if (v.tags?.rotate) rotation = Number(v.tags.rotate);
  const swap = Math.abs(rotation) % 180 === 90;
  const [n, d] = String(v.avg_frame_rate || v.r_frame_rate || "0/1").split("/").map(Number);
  const fps = d ? n / d : n;
  return {
    durationSec: Number(probe.format?.duration ?? v.duration ?? 0),
    width: swap ? v.height : v.width,
    height: swap ? v.width : v.height,
    videoCodec: String(v.codec_name),
    audioCodec: a ? String(a.codec_name) : null,
    audioSampleRate: a?.sample_rate ? Number(a.sample_rate) : null,
    fps: Math.round(fps * 100) / 100,
    sizeBytes,
    container: String(probe.format?.format_name ?? "unknown"),
    pixFmt: v.pix_fmt ?? null,
  };
}

export async function probe(path: string): Promise<MediaInfo> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path], { maxBuffer: 10 * 1024 * 1024 });
  return parseProbe(JSON.parse(stdout), statSync(path).size);
}

/**
 * Story rendition: scale the COMPLETE frame to fit inside 1080x1920 (aspect preserved, no crop, no stretch),
 * pad the remainder with black, H.264/AAC MP4 with faststart. Optionally a time range for segmented Stories.
 */
export async function renderStory(src: string, dest: string, info: MediaInfo, segment?: StorySegment): Promise<void> {
  const { width: W, height: H } = STORY_CANVAS;
  const vf = `scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${Math.min(60, Math.max(24, Math.round(info.fps)))},format=yuv420p`;
  const args = ["-y", "-v", "error"];
  if (segment) args.push("-ss", String(segment.startSec), "-t", String(segment.durationSec));
  args.push("-i", src, "-map", "0:v:0", "-map", "0:a:0?", "-vf", vf, "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-profile:v", "high", "-g", String(Math.round(info.fps * 2)), "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-movflags", "+faststart", dest);
  await run("ffmpeg", args, { maxBuffer: 10 * 1024 * 1024 });
}
