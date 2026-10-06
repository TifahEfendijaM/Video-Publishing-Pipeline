// ffprobe / ffmpeg wrappers. The original file is never modified.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { statSync } from "node:fs";
import type { MediaInfo, StorySegment } from "../../src/shared/media";
import { STORY_CANVAS, WIDESCREEN_CANVAS } from "../../src/shared/media";

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
 * Fit the COMPLETE frame inside a canvas (aspect preserved, no crop, no stretch), pad the rest with black,
 * H.264/AAC MP4 with faststart, bitrate-capped so renditions stay small. Optional time range (Story parts).
 */
export async function renderCanvas(src: string, dest: string, info: MediaInfo, canvas: { width: number; height: number }, segment?: StorySegment): Promise<void> {
  const { width: W, height: H } = canvas;
  const vf = `scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${Math.min(60, Math.max(24, Math.round(info.fps)))},format=yuv420p`;
  const args = ["-y", "-v", "error"];
  if (segment) args.push("-ss", String(segment.startSec), "-t", String(segment.durationSec));
  args.push("-i", src, "-map", "0:v:0", "-map", "0:a:0?", "-vf", vf, "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-maxrate", "4M", "-bufsize", "8M", "-profile:v", "high", "-g", String(Math.round(info.fps * 2)), "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-movflags", "+faststart", dest);
  await run("ffmpeg", args, { maxBuffer: 10 * 1024 * 1024 });
}

/** Story rendition: complete frame letterboxed onto 1080x1920. */
export function renderStory(src: string, dest: string, info: MediaInfo, segment?: StorySegment): Promise<void> {
  return renderCanvas(src, dest, info, STORY_CANVAS, segment);
}

/** Regular-YouTube rendition of a Short-shaped clip: complete frame pillarboxed onto 1920x1080. */
export function renderWidescreen(src: string, dest: string, info: MediaInfo): Promise<void> {
  return renderCanvas(src, dest, info, WIDESCREEN_CANVAS);
}

/**
 * Append an outro clip to the end of a video. The result keeps the main video's frame size; the outro is
 * fitted inside it (aspect preserved, black bars, no crop). Clips without audio get silence so the joined
 * file always has one continuous audio track. Re-encoded (H.264/AAC), bitrate-capped for temporary hosting.
 */
export async function concatWithOutro(main: string, mainInfo: MediaInfo, outro: string, outroInfo: MediaInfo, dest: string): Promise<void> {
  const W = mainInfo.width - (mainInfo.width % 2);
  const H = mainInfo.height - (mainInfo.height % 2);
  const fps = Math.min(60, Math.max(24, Math.round(mainInfo.fps)));
  const args = ["-y", "-v", "error", "-i", main, "-i", outro];
  let next = 2;
  const audioIn = (info: MediaInfo, idx: number) => {
    if (info.audioCodec) return `${idx}:a:0`;
    args.push("-f", "lavfi", "-t", String(info.durationSec), "-i", "anullsrc=r=48000:cl=stereo");
    return `${next++}:a:0`;
  };
  const a0 = audioIn(mainInfo, 0);
  const a1 = audioIn(outroInfo, 1);
  const v = (i: number) => `[${i}:v:0]scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},format=yuv420p[v${i}]`;
  const a = (src: string, i: number) => `[${src}]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`;
  const graph = [v(0), v(1), a(a0, 0), a(a1, 1), "[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]"].join(";");
  args.push("-filter_complex", graph, "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-maxrate", "3500k", "-bufsize", "7M", "-profile:v", "high", "-g", String(fps * 2), "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-movflags", "+faststart", dest);
  await run("ffmpeg", args, { maxBuffer: 10 * 1024 * 1024 });
}
