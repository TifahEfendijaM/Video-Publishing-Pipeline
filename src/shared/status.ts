// Publication states shown in summaries and stored per platform/surface.

export const PUBLICATION_STATUSES = [
  "initiated", // request sent / upload started; nothing confirmed yet
  "processing", // provider accepted media and is processing it; not yet confirmed public
  "confirmed", // publication confirmed by the provider's status/read-back mechanism
  "failed", // definitively failed — nothing was published (safe to retry explicitly)
  "uncertain", // the outcome cannot be determined; never retried automatically
  "unsupported", // unsupported by an available official route, or needs a manual step
  "disabled", // skipped by the kill switch, a cancelled/stale schedule, or missing identity verification
] as const;

export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];

export const STATUS_LABEL: Record<PublicationStatus, string> = {
  initiated: "⏳ Upload initiated",
  processing: "🔄 Media processing",
  confirmed: "✅ Publication confirmed",
  failed: "❌ Failed",
  uncertain: "⚠️ Outcome uncertain",
  unsupported: "🚫 Unsupported / manual",
  disabled: "⏸️ Disabled",
};

/** Statuses that mean the video may already be (or become) visible on that destination. */
export function mayBeLive(s: PublicationStatus): boolean {
  return s === "initiated" || s === "processing" || s === "confirmed" || s === "uncertain";
}

/** Only a definitive failure may be re-attempted, and only by an explicit retry request. */
export function isRetryable(s: PublicationStatus): boolean {
  return s === "failed";
}

export type Platform = "instagram" | "facebook" | "tiktok" | "youtube";
export type Surface = string; // "feed" | "story" | "story_part_1" ...

/** Error thrown before anything could have been published (validation, auth, upload never accepted). */
export class SafeFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafeFailure";
  }
}

/** Error thrown when a publish request may or may not have taken effect (timeouts, 5xx after submit...). */
export class AmbiguousOutcome extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmbiguousOutcome";
  }
}
