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

/** Recovery may follow a majority move, including one made earlier in this same run. */
export async function findRetryVideo(fileId: string, sourceVideos: import("../../src/shared/selection").FolderVideo[], drive: Pick<import("./google").Drive, "stillInFolder" | "publishedFolder" | "listVideos">) {
  const source = sourceVideos.find(v => v.id === fileId);
  if (source && await drive.stillInFolder(fileId)) return source;
  const archive = await drive.publishedFolder(false);
  if (archive) {
    const video = (await drive.listVideos(archive.id)).find(v => v.id === fileId);
    if (video && await drive.stillInFolder(fileId, archive.id)) return video;
  }
  throw new Error(`Video ${fileId} is no longer in the source or Published videos folder; cannot retry.`);
}
