// Publication rows are temporary recovery checkpoints, never a permanent selection cursor.
import { mayBeLive, type PublicationStatus } from "../../src/shared/status";
import { isOutroName, type FolderVideo } from "../../src/shared/selection";
import { summarizeError } from "../../src/shared/redact";

export interface PublicationCheckpoint {
  id: number;
  file_id: string;
  platform: string;
  surface: string;
  status: PublicationStatus;
}

/** A retry replaces only its own destination, preserving the other destinations' outcomes. */
export function latestPublications<T extends PublicationCheckpoint>(rows: T[]): T[] {
  const latest = new Map<string, T>();
  for (const p of rows) {
    const key = `${p.platform}:${p.surface}`;
    if (!latest.has(key) || latest.get(key)!.id < p.id) latest.set(key, p);
  }
  return [...latest.values()];
}

export function confirmedForCleanup(rows: PublicationCheckpoint[]): boolean {
  const latest = latestPublications(rows);
  return latest.some((p) => p.status === "confirmed") && latest.every((p) => p.status === "confirmed" || p.status === "unsupported");
}

export interface QueueDeps {
  publications(fileId: string): Promise<PublicationCheckpoint[]>;
  trash(fileId: string): Promise<void>;
  complete(fileId: string): Promise<unknown>;
}

/** Retry cleanup without republishing; retain partial/pending sources for explicit recovery. */
export async function maintainQueue(videos: FolderVideo[], protectedIds: Set<string>, deps: QueueDeps, preview = false) {
  const blockedIds = new Set<string>();
  const notes: string[] = [];
  for (const v of videos) {
    if (protectedIds.has(v.id) || isOutroName(v.name)) continue;
    // Fail closed on state errors: a missing checkpoint response is not an unpublished video.
    const rows = latestPublications(await deps.publications(v.id));
    if (confirmedForCleanup(rows)) {
      blockedIds.add(v.id);
      if (preview) {
        notes.push(`"${v.name}" is confirmed and awaiting Drive cleanup (preview does not remove files).`);
        continue;
      }
      try {
        await deps.trash(v.id);
        await deps.complete(v.id);
        notes.push(`"${v.name}" removed from the source folder to Drive Trash after confirmed publishing; recovery checkpoints cleared.`);
      } catch (e) {
        notes.push(`WARNING: cleanup of "${v.name}" needs attention: ${summarizeError(e, 200)}. It will not be republished; cleanup will be retried on the next publishing run or Tools → reconcile.`);
      }
    } else if (rows.some((p) => mayBeLive(p.status))) {
      blockedIds.add(v.id);
      notes.push(`"${v.name}" retained for pending/partial publishing; use reconcile, resolve_publication or retry_failed. It will not be republished automatically.`);
    }
  }
  return { blockedIds, notes };
}
