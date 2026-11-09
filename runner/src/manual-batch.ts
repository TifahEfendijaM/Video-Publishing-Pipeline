import { interpretManualEntry, resolveManualEntry } from './publishing-plan';
import type { CaptionModel } from './captioner';
import type { FolderVideo } from '../../src/shared/selection';
import type { ScheduledJob } from '../../worker/src/jobs';
import { effectiveOutro, isVideo } from '../../src/shared/selection';
import { mayBeLive } from '../../src/shared/status';

/** Batch delimiters are newline and |, except inside quoted filenames. */
export function splitManualBatch(text: string): string[] {
  const parts: string[] = [];
  let current = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { current += '""'; i++; continue; }
      quoted = !quoted;
    }
    if (!quoted && (c === '|' || c === '\n' || c === '\r')) {
      if (current.trim()) parts.push(current.trim());
      current = '';
    } else current += c;
  }
  if (quoted) throw new Error('Unclosed quote in manual batch');
  if (current.trim()) parts.push(current.trim());
  return parts;
}

export async function interpretManualBatch(text: string, model: CaptionModel) {
  if (!text.trim() || text.length > 8000) throw new Error('Manual batch needs 1–8000 characters');
  const lines = splitManualBatch(text);
  if (!lines.length || lines.length > 20) throw new Error('Manual batch needs 1–20 video entries');
  const entries = await Promise.all(lines.map(line => interpretManualEntry(line, model)));
  if (entries.length > 1 && entries.some(e => e.selection?.policy !== 'custom' || e.selection.filenames.length !== 1))
    throw new Error('Every batch entry must name exactly one Custom video filename');
  return entries;
}

export type BatchEntry = ReturnType<typeof resolveManualEntry> & { fileId: string; fileName: string };

interface BatchDependencies {
  videos: FolderVideo[];
  allowDeletedSources?:boolean;
  jobs: Pick<ScheduledJob, 'remaining'>[];
  publications: (fileId: string) => Promise<{ status: string }[]>;
  stillInFolder: (fileId: string) => Promise<boolean>;
  validateThumbnail?: (fileId:string,seconds:number)=>Promise<void>;
  savedOutros?: Record<string, { fileId: string; fileName: string } | null>;
  planOutros?: ({ fileId: string; fileName: string } | null)[];
  defaultOutroFilename?: string;
}

/** Fail closed on the whole batch before any run is created or provider is called. */
export async function preflightManualBatch(
  entries: Awaited<ReturnType<typeof interpretManualBatch>>,
  deps: BatchDependencies,
): Promise<BatchEntry[]> {
  if (!entries.length) throw new Error('Preflight requires at least one entry');
  const reserved = new Set(deps.jobs.flatMap(j => j.remaining.map(v => v.fileId)));
  const selected = new Set<string>();
  const resolved: BatchEntry[] = [];
  for (const entry of entries) {
    if (entry.selection?.policy !== 'custom' || entry.selection.filenames.length !== 1)
      throw new Error('Each batch entry requires one exact video filename');
    const item = resolveManualEntry(entry, deps.videos);
    if (!item.pendingCustom) throw new Error('Missing batch filename');
    const { fileId, fileName } = item.pendingCustom;
    const video = deps.videos.find(v => v.id === fileId);
    if (!video || !isVideo(video)) throw new Error(`"${fileName}" is not a video`);
    if (selected.has(fileId)) throw new Error(`Duplicate video in manual batch: "${fileName}"`);
    if (reserved.has(fileId)) throw new Error(`"${fileName}" belongs to a scheduled Custom reservation`);
    selected.add(fileId);
    resolved.push({ ...item, fileId, fileName });
  }
  const assetIds = new Set<string>(resolved.flatMap(e => Object.values(e.outroOverrides).flatMap(v => v ? [v.fileId] : [])));
  for (const entry of resolved) for (const platform of ['youtube','tiktok','instagram','facebook'] as const) {
    const saved = platform in entry.outroOverrides ? entry.outroOverrides[platform] : deps.savedOutros?.[platform];
    const outro = effectiveOutro(saved, deps.videos, deps.defaultOutroFilename ?? '');
    if (outro) assetIds.add(outro.fileId);
  }
  for (const outro of deps.planOutros ?? []) if (outro) assetIds.add(outro.fileId);
  for (const assetId of assetIds) {
    const asset = deps.videos.find(v => v.id === assetId);
    if (!asset || !isVideo(asset)) throw new Error('Batch outro is not a video asset');
    if (selected.has(assetId)) throw new Error(`"${asset.name}" cannot be both a batch video and an outro: source archival could break later entries`);
  }
  for (const id of new Set([...selected, ...assetIds])) {
    if (!await deps.stillInFolder(id)) throw new Error(`Batch source or outro ${id} is no longer in the Drive input folder`);
  }
  for (const id of new Set([...selected, ...assetIds])) {
    const rows = await deps.publications(id);
    if (rows.some(p => p.status === 'confirmed' || mayBeLive(p.status as Parameters<typeof mayBeLive>[0])) && !(deps.allowDeletedSources && selected.has(id) && !assetIds.has(id)))
      throw new Error(`"${deps.videos.find(v=>v.id===id)?.name ?? id}" has existing confirmed/live/pending publication checkpoints; use retry_failed for missing destinations, or fresh_after_deleting only after deleting previous platform posts`);
  }
  for(const entry of resolved) if(entry.thumbnailSec!=null) await deps.validateThumbnail?.(entry.fileId,entry.thumbnailSec);
  return resolved;
}
