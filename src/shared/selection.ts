// Video selection: FIFO / LIFO by folder-entry time, one-run custom overrides, exhaustion.

export type SelectionPolicy = "fifo" | "lifo";
export type SelectionChoice = SelectionPolicy | "custom";

export type EntrySource =
  | "drive_activity" // exact: Drive Activity API create/upload/move-into-folder event
  | "observed" // first time this pipeline saw the file in the folder (accurate to the sync interval)
  | "created_time_approximation"; // Drive createdTime — NOT folder-entry time; labelled approximation

export interface FolderVideo {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number | null;
  md5: string | null;
  createdTime: string;
  modifiedTime: string;
}

export interface VideoRecord {
  fileId: string;
  enteredFolderAt: string | null;
  entrySource: EntrySource | null;
  consumed: boolean;
  md5AtPublication: string | null;
}

export interface RankedVideo extends FolderVideo {
  enteredAt: string;
  entrySource: EntrySource;
}

/** Combine the live folder listing with stored entry times. Falls back to createdTime, labelled as an approximation. */
export function rankable(videos: FolderVideo[], records: Map<string, VideoRecord>): RankedVideo[] {
  return videos.map((v) => {
    const r = records.get(v.id);
    if (r?.enteredFolderAt && r.entrySource) return { ...v, enteredAt: r.enteredFolderAt, entrySource: r.entrySource };
    return { ...v, enteredAt: v.createdTime, entrySource: "created_time_approximation" as const };
  });
}

/** Oldest-first (fifo) or newest-first (lifo); identical timestamps are broken by file ID (ascending) in both modes. */
export function orderVideos(videos: RankedVideo[], policy: SelectionPolicy): RankedVideo[] {
  const dir = policy === "fifo" ? 1 : -1;
  return [...videos].sort((a, b) => {
    const ta = Date.parse(a.enteredAt);
    const tb = Date.parse(b.enteredAt);
    if (ta !== tb) return (ta - tb) * dir;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function isVideo(v: FolderVideo): boolean {
  return v.mimeType.startsWith("video/");
}

export type CustomResolution =
  | { kind: "match"; video: FolderVideo; note?: string }
  | { kind: "blank" }
  | { kind: "not_found"; name: string }
  | { kind: "ambiguous"; name: string; count: number };

/**
 * Resolve a filename inside the folder listing only. Exact full-filename match (with extension) is preferred;
 * a unique case-insensitive match is accepted and reported. Duplicates are never chosen arbitrarily.
 * The listing passed in must be a successful listing: authorization/network errors must be raised before this.
 */
export function resolveCustomName(input: string | null | undefined, videos: FolderVideo[]): CustomResolution {
  const name = (input ?? "").normalize("NFC").trim();
  if (name === "") return { kind: "blank" };
  const exact = videos.filter((v) => v.name.normalize("NFC") === name);
  if (exact.length === 1) return { kind: "match", video: exact[0] };
  if (exact.length > 1) return { kind: "ambiguous", name, count: exact.length };
  const ci = videos.filter((v) => v.name.normalize("NFC").toLowerCase() === name.toLowerCase());
  if (ci.length === 1) return { kind: "match", video: ci[0], note: "matched ignoring upper/lower case" };
  if (ci.length > 1) return { kind: "ambiguous", name, count: ci.length };
  return { kind: "not_found", name };
}

export interface SelectionInput {
  policy: SelectionPolicy; // saved FIFO/LIFO policy
  customName?: string | null; // manual_now custom filename (one-run)
  pendingCustomFileId?: string | null; // automated: saved one-occurrence override
  pendingCustomFileName?: string | null;
  videos: FolderVideo[]; // successful listing of the folder (videos only)
  records: Map<string, VideoRecord>;
  excludeIds?: Set<string>; // configured outro clips: never picked by FIFO/LIFO (custom may still pick them)
}

/** Outro clips are excluded from automatic selection: configured outros, and any file whose name contains "outro". */
export function isOutroName(name: string): boolean {
  return /outro/i.test(name);
}

export interface SelectionResult {
  video: RankedVideo | null;
  method: "fifo" | "lifo" | "custom";
  fallback: string | null; // why a custom request fell back to FIFO/LIFO
  notes: string[];
  eligibleCount: number;
}

export function selectVideo(input: SelectionInput): SelectionResult {
  const videos = input.videos.filter(isVideo);
  const ranked = rankable(videos, input.records);
  const notes: string[] = [];
  let fallback: string | null = null;

  if (input.pendingCustomFileId) {
    const v = ranked.find((x) => x.id === input.pendingCustomFileId);
    if (v) {
      return { video: v, method: "custom", fallback: null, notes, eligibleCount: ranked.length };
    }
    fallback = `The saved custom video "${input.pendingCustomFileName ?? input.pendingCustomFileId}" (ID ${input.pendingCustomFileId}) is no longer in the folder (deleted, trashed or moved); using the saved ${input.policy.toUpperCase()} policy.`;
  } else if (input.customName !== undefined && input.customName !== null) {
    const r = resolveCustomName(input.customName, videos);
    if (r.kind === "match") {
      if (r.note) notes.push(`Custom filename ${r.note}.`);
      const v = ranked.find((x) => x.id === r.video.id)!;
      if (input.records.get(v.id)?.consumed) notes.push("This video was published by the pipeline before; republishing it was explicitly requested.");
      return { video: v, method: "custom", fallback: null, notes, eligibleCount: ranked.length };
    }
    if (r.kind === "blank") fallback = `Custom selected but the filename was empty; using the saved ${input.policy.toUpperCase()} policy.`;
    if (r.kind === "not_found") fallback = `No video named "${r.name}" exists in the folder; using the saved ${input.policy.toUpperCase()} policy.`;
    if (r.kind === "ambiguous") fallback = `${r.count} videos in the folder are named "${r.name}"; the custom choice is ambiguous, so the saved ${input.policy.toUpperCase()} policy is used.`;
  }

  const outros = ranked.filter((v) => input.excludeIds?.has(v.id) || isOutroName(v.name));
  if (outros.length) notes.push(`${outros.length} outro clip(s) excluded from automatic selection: ${outros.map((v) => v.name).join(", ")}.`);
  const eligible = ranked.filter((v) => !input.records.get(v.id)?.consumed && !outros.includes(v));
  const ordered = orderVideos(eligible, input.policy);
  if (ordered.some((v) => v.entrySource === "created_time_approximation")) {
    notes.push("Some folder-entry times are approximated by Drive createdTime (exact entry time unavailable).");
  }
  return { video: ordered[0] ?? null, method: input.policy, fallback, notes, eligibleCount: eligible.length };
}

export const NO_ELIGIBLE_MESSAGE = "No eligible videos available.";
