/** Publishing intent, independent of credentials, enabled accounts and media eligibility. */
export const DESTINATIONS = ['instagram/reel', 'instagram/story', 'facebook/feed', 'facebook/story', 'tiktok/feed', 'youtube/short', 'youtube/video'] as const;
export type Destination = typeof DESTINATIONS[number];

export function validateDestinations(value: unknown = undefined): Destination[] {
  if (value === undefined) return [...DESTINATIONS];
  if (!Array.isArray(value) || !value.length || value.some(d => !DESTINATIONS.includes(d)) || new Set(value).size !== value.length) {
    throw new Error('Choose at least one supported destination; unknown or duplicate destinations are not allowed');
  }
  return DESTINATIONS.filter(d => value.includes(d));
}

/** Canonical clauses accept platform names, exact surfaces, or all except a list. */
export function parseDestinations(text: string): Destination[] {
  const value = text.trim().toLowerCase();
  if (value === 'all') return [...DESTINATIONS];
  const exclude = /^all except\s+(.+)$/.exec(value);
  const tokens = (exclude?.[1] ?? value).split(',').map(t => t.trim());
  if (tokens.some(t => !t) || new Set(tokens).size !== tokens.length) throw new Error('Invalid destination list');
  const selected = new Set<Destination>();
  for (const token of tokens) {
    const matches = DESTINATIONS.filter(d => d === token || d.split('/')[0] === token);
    if (!matches.length) throw new Error(`Unsupported destination: ${token}`);
    for (const d of matches) selected.add(d);
  }
  return validateDestinations(DESTINATIONS.filter(d => exclude ? !selected.has(d) : selected.has(d)));
}

export const includesDestination = (value: Destination[] | undefined, destination: Destination) => validateDestinations(value).includes(destination);
export const destinationDescription = (value?: Destination[]) => {
  const selected = validateDestinations(value);
  return selected.length === DESTINATIONS.length ? 'all platforms (YouTube Short and regular video)' : selected.join(', ');
};
export const destinationClause = (value?: Destination[]) => `; destinations: ${validateDestinations(value).length === DESTINATIONS.length ? 'all' : validateDestinations(value).join(', ')}`;

export function taskDestination(platform: string, surface: string): Destination {
  if (platform === 'youtube') return `youtube/${surface}` as Destination;
  if (platform === 'instagram') return surface.startsWith('story') ? 'instagram/story' : 'instagram/reel';
  if (platform === 'facebook') return surface.startsWith('story') ? 'facebook/story' : 'facebook/feed';
  // The existing TikTok Story row is only an unsupported/manual notice alongside its feed task.
  if (platform === 'tiktok') return 'tiktok/feed';
  throw new Error(`Unknown publishing platform: ${platform}`);
}
