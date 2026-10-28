// Select from the live source folder by upload date, random choice, or one-run filename override.

export type SelectionPolicy = "fifo" | "lifo" | "random";
export type SelectionChoice = SelectionPolicy | "custom";

export interface FolderVideo {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number | null;
  md5: string | null;
  createdTime: string;
  modifiedTime: string;
}

/** Oldest-first (fifo) or newest-first (lifo) by Drive createdTime; identical timestamps are broken by file ID (ascending) in both modes. */
export function orderVideos(videos: FolderVideo[], policy: "fifo" | "lifo"): FolderVideo[] {
  const dir = policy === "fifo" ? 1 : -1;
  return [...videos].sort((a, b) => {
    const ta = Date.parse(a.createdTime);
    const tb = Date.parse(b.createdTime);
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
  policy: SelectionPolicy; // saved FIFO/LIFO/random policy
  customName?: string | null; // manual_now custom filename (one-run)
  pendingCustomFileId?: string | null; // automated: saved one-occurrence override
  pendingCustomFileName?: string | null;
  videos: FolderVideo[]; // successful listing of the folder (videos only)
  random?: () => number; // injectable uniform draw in [0, 1), defaults to Math.random
  excludeIds?: Set<string>; // configured outro clips: never picked automatically (custom may still pick them)
  blockedIds?: Set<string>; // temporary pending/partial publications or confirmed files awaiting cleanup
}

/** Outro clips are excluded from automatic selection: configured outros, and any file whose name contains "outro". */
export function isOutroName(name: string): boolean {
  return /outro/i.test(name);
}

export interface SelectionResult {
  video: FolderVideo | null;
  method: SelectionChoice;
  fallback: string | null; // why a custom request fell back to the saved policy
  notes: string[];
  eligibleCount: number;
}

export function selectVideo(input: SelectionInput): SelectionResult {
  const videos = input.videos.filter(isVideo);
  const ranked = videos.filter((v) => !input.blockedIds?.has(v.id));
  const notes: string[] = [];
  let fallback: string | null = null;

  const requested = input.pendingCustomFileId ?? (input.customName ? (() => {
    const r = resolveCustomName(input.customName, videos);
    return r.kind === "match" ? r.video.id : null;
  })() : null);
  if (requested && input.blockedIds?.has(requested)) {
    notes.push("The requested video has pending/partial publications or is awaiting Drive cleanup. Use the recovery tools before publishing it again.");
    return { video: null, method: "custom", fallback: null, notes, eligibleCount: ranked.length };
  }

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
      return { video: v, method: "custom", fallback: null, notes, eligibleCount: ranked.length };
    }
    if (r.kind === "blank") fallback = `Custom selected but the filename was empty; using the saved ${input.policy.toUpperCase()} policy.`;
    if (r.kind === "not_found") fallback = `No video named "${r.name}" exists in the folder; using the saved ${input.policy.toUpperCase()} policy.`;
    if (r.kind === "ambiguous") fallback = `${r.count} videos in the folder are named "${r.name}"; the custom choice is ambiguous, so the saved ${input.policy.toUpperCase()} policy is used.`;
  }

  const outros = ranked.filter((v) => input.excludeIds?.has(v.id) || isOutroName(v.name));
  if (outros.length) notes.push(`${outros.length} outro clip(s) excluded from automatic selection: ${outros.map((v) => v.name).join(", ")}.`);
  const eligible = ranked.filter((v) => !outros.includes(v));
  let video: FolderVideo | null = null;
  if (eligible.length && input.policy === "random") {
    const draw = (input.random ?? Math.random)();
    if (!Number.isFinite(draw) || draw < 0 || draw >= 1) throw new Error("Random draw must be in [0, 1)");
    video = eligible[Math.floor(draw * eligible.length)];
  } else if (input.policy !== "random") video = orderVideos(eligible, input.policy)[0] ?? null;
  return { video, method: input.policy, fallback, notes, eligibleCount: eligible.length };
}

export const NO_ELIGIBLE_MESSAGE = "No eligible videos available.";

export type SavedOutro = { fileId: string; fileName: string } | null | undefined;

/**
 * Which outro clip applies to a platform: an explicitly saved clip; none if it was explicitly removed (null);
 * otherwise the default clip (matched by exact filename in the folder, only if exactly one file matches).
 */
export function effectiveOutro(saved: SavedOutro, videos: FolderVideo[], defaultFileName: string): { fileId: string; fileName: string; source: "saved" | "default" } | null {
  if (saved === null) return null;
  if (saved) return { ...saved, source: "saved" };
  if (!defaultFileName) return null;
  const r = resolveCustomName(defaultFileName, videos);
  return r.kind === "match" ? { fileId: r.video.id, fileName: r.video.name, source: "default" } : null;
}
