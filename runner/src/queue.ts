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

import { latestOutcomes, fullyConfirmed, majorityConfirmed, platformPublicationCounts } from '../../src/shared/archive-policy';
export { latestOutcomes as latestPublications } from '../../src/shared/archive-policy';
export const confirmedForCleanup=fullyConfirmed;
const latestPublications=latestOutcomes;

export interface QueueDeps {
  partialArchiveSupported?:boolean;
  publications(fileId: string): Promise<PublicationCheckpoint[]>;
  archive(fileId: string): Promise<void>;
  complete(fileId: string): Promise<unknown>;
}

/** A move may succeed before the state API responds. Finish that cleanup on a later run. */
export async function completeArchived(archivedIds: Set<string>, checkpointIds: string[], deps: QueueDeps): Promise<number> {
  let completed = 0;
  for (const id of checkpointIds) {
    if(!archivedIds.has(id)) continue;
    const rows=await deps.publications(id);
    const final=confirmedForCleanup(rows);
    if(final || (deps.partialArchiveSupported && majorityConfirmed(rows))) {
      await deps.complete(id);
      if(final) completed++;
    }
  }
  return completed;
}

/** Archive confirmed platform majorities without discarding partial recovery state. */
export async function maintainQueue(videos: FolderVideo[], protectedIds: Set<string>, deps: QueueDeps, preview = false) {
  const blockedIds = new Set<string>();
  const notes: string[] = [];
  const archivedIds = new Set<string>();
  const clearedIds = new Set<string>();
  for (const v of videos) {
    if (protectedIds.has(v.id) || isOutroName(v.name)) continue;
    // Fail closed on state errors: a missing checkpoint response is not an unpublished video.
    const rows = latestPublications(await deps.publications(v.id));
    if (majorityConfirmed(rows)) {
      const final=confirmedForCleanup(rows);
      const counts=platformPublicationCounts(rows);
      blockedIds.add(v.id);
      if(!final && !deps.partialArchiveSupported) {
        notes.push(`"${v.name}" has a confirmed platform majority, but the scheduler must be deployed before partial recovery records can safely be retained.`);
        continue;
      }
      if (preview) {
        notes.push(`"${v.name}" has a confirmed platform majority and is awaiting Drive cleanup (preview does not remove files).`);
        continue;
      }
      try {
        await deps.archive(v.id);
        await deps.complete(v.id);
        archivedIds.add(v.id);
        if(final) {
          clearedIds.add(v.id);
          notes.push(`"${v.name}" moved from the source folder into Published videos after confirmed publishing; recovery checkpoints cleared.`);
        } else notes.push(`"${v.name}" moved into Published videos: ${counts.confirmed} confirmed platform(s) outnumber ${counts.unconfirmed} unconfirmed platform(s). Recovery checkpoints retained; reconcile pending uploads or retry only failed destinations.`);
      } catch (e) {
        notes.push(`WARNING: cleanup of "${v.name}" needs attention: ${summarizeError(e, 200)}. It will not be republished; cleanup will be retried on the next publishing run or Tools → reconcile.`);
      }
    } else if (rows.some((p) => mayBeLive(p.status))) {
      blockedIds.add(v.id);
      notes.push(`"${v.name}" retained for pending/partial publishing; use reconcile, resolve_publication or retry_failed. It will not be republished automatically.`);
    }
  }
  return { blockedIds, archivedIds, clearedIds, notes };
}
