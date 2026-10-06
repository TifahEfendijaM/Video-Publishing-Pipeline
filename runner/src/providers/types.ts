import type { PublicationStatus } from "../../../src/shared/status";

export interface Outcome {
  status: PublicationStatus;
  remoteId?: string | null;
  url?: string | null;
  detail?: string | null;
}

/** Re-checks the kill switch / stale-schedule state. Providers call it right before the irreversible step. */
export type Gate = () => Promise<{ allowed: boolean; reason: string | null }>;

/** Lets a provider persist intermediate state (e.g. a container or video ID) before waiting on processing. */
export type Progress = (status: PublicationStatus, remoteId?: string | null, detail?: string | null) => Promise<void>;

export interface IdentityCheck {
  ok: boolean;
  detail: string;
}
