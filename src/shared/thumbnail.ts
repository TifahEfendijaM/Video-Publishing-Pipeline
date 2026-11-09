/** Undefined/null means inspect this video's own frames, never reuse another video's choice. */
export function validThumbnailSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 86400;
}

export function parseThumbnailTime(text: string): number | null {
  const value = text.trim();
  if (!value || /^auto$/i.test(value)) return null;
  if (!/^\d{1,5}(?:\.\d{1,3})?$/.test(value) && !/^\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?$/.test(value))
    throw new Error('Use thumbnail: auto or a timestamp such as 00:18.5 or 01:02:03');
  const parts = value.split(':').map(Number);
  if (parts.length > 1 && parts.slice(1).some(p => p >= 60)) throw new Error('Thumbnail minutes/seconds must be below 60');
  const seconds = parts.reduce((n,p) => n * 60 + p, 0);
  if (!validThumbnailSeconds(seconds)) throw new Error('Invalid thumbnail timestamp');
  return seconds;
}

export function thumbnailClause(seconds?: number | null): string {
  return `; thumbnail: ${seconds == null ? 'auto' : seconds}`;
}
