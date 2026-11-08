import { isRetryable } from "../../src/shared/status";
import { latestPublications, type PublicationCheckpoint } from "./queue";

/** An explicit destination list can narrow a retry, never broaden it to live/pending outcomes. */
export function selectRetryPublications<T extends PublicationCheckpoint>(run: T[], all: T[], destinations: string): T[] {
  const latest = latestPublications(all);
  const eligible = run.filter((p) => isRetryable(p.status) && latest.some((q) => q.id === p.id));
  if (!destinations.trim()) return eligible;
  const requested = new Set(destinations.trim().split(/[\s,]+/));
  for (const key of requested) {
    if (!eligible.some((p) => `${p.platform}/${p.surface}` === key)) {
      throw new Error(`Cannot retry ${key}: it is not a current failed or disabled destination in this run`);
    }
  }
  return eligible.filter((p) => requested.has(`${p.platform}/${p.surface}`));
}
