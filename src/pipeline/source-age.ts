/** The live preview's collection window, and fetchRss's own default. A story older than this was not "current" when it was selected. */
export const DEFAULT_EDITION_WINDOW_HOURS = 72;

/** Wording that points at the edition's own day. It is only true if the source is from that day,
 * so the validators, tests and docs share this one list. */
export const EDITION_RELATIVE_PHRASES = ['this week', 'today', 'yesterday', 'tomorrow', 'upcoming', 'next month'] as const;

// "USA Today" is an outlet, not a date (NEWSLETTER_SOURCE_CONTEXT_RULES says the same to the writer).
const EDITION_RELATIVE_PATTERN = new RegExp(`\\b(?<!USA )(${EDITION_RELATIVE_PHRASES.map(phrase => phrase.replace(' ', '\\s+')).join('|')})\\b`, 'gi');

export interface SourceAge { publishedOn: string; days: number }

/** Whole calendar days between a source's publication day and the edition day, or null when either is unknown.
 * Only the date is compared: an edition has no hour, and a time-zone edge must never mark a fresh source stale. */
export function sourceAgeDays(publishedAt: string | null | undefined, editionDay: string): SourceAge | null {
  const published = typeof publishedAt === 'string' ? /^(\d{4}-\d{2}-\d{2})(?:T|$)/.exec(publishedAt)?.[1] : undefined;
  if (!published || !/^\d{4}-\d{2}-\d{2}$/.test(editionDay)) return null;
  const days = (Date.parse(editionDay) - Date.parse(published)) / 86_400_000;
  return Number.isFinite(days) ? { publishedOn: published, days } : null;
}

/** Older than the window, counted in whole days (a 72-hour window tolerates 3 days, flags 4). */
export const isOutsideWindow = (age: SourceAge | null, windowHours: number): age is SourceAge => age !== null && age.days * 24 > windowHours;

/** A story is stale only when every cited source has a known date and all of them are outside the window; the result is the
 * freshest of them, since the story is only as old as its newest source. One fresh or undated source leaves open that the
 * wording is justified, so the model reviewers keep that call. */
export function freshestStaleAge(publishedAts: readonly (string | null | undefined)[], editionDay: string, windowHours: number): SourceAge | null {
  if (!publishedAts.length) return null;
  const ages = publishedAts.map(value => sourceAgeDays(value, editionDay));
  if (!ages.every(age => isOutsideWindow(age, windowHours))) return null;
  return (ages as SourceAge[]).reduce((newest, age) => age.days < newest.days ? age : newest);
}

/** Validator finding for edition-relative wording in text about a stale story, phrased so a repair pass can act on it. */
export function staleEditionWording(text: string, publishedAts: readonly (string | null | undefined)[], editionDay: string, windowHours: number): string | null {
  const age = freshestStaleAge(publishedAts, editionDay, windowHours);
  if (!age) return null;
  const found = [...new Set([...text.matchAll(EDITION_RELATIVE_PATTERN)].map(match => match[1]!.toLowerCase().replace(/\s+/g, ' ')))];
  if (!found.length) return null;
  return `text uses edition-relative wording (${found.slice(0, 3).map(phrase => `"${phrase}"`).join(', ')}) for a source published ${age.publishedOn}, ${age.days} days before the ${editionDay} edition and outside its ${windowHours}-hour window. `
    + `Do not present it as current or upcoming: name the date it was reported, or describe it without relative timing.`;
}

/** "reported Sep 14", with the year only when it is not the edition's own. Date-only: no clock is implied. */
export function reportedMarker(info: { publishedOn: string }, editionDay: string): string {
  const [year, month, day] = info.publishedOn.split('-').map(Number) as [number, number, number];
  const name = new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `reported ${name}${String(year) === editionDay.slice(0, 4) ? '' : `, ${year}`}`;
}

/** Per selected story (keyed by its primary URL), the publication day and age of stories that are stale as a whole.
 * The primary source's own date is reported when known, else the freshest source's. */
export function staleStoryAges(stories: readonly { primaryUrl: string; sources: readonly { url: string; publishedAt?: string | null }[] }[], editionDay: string, windowHours: number): Record<string, { publishedOn: string; days: number }> {
  const stale: Record<string, { publishedOn: string; days: number }> = {};
  for (const story of stories) {
    const freshest = freshestStaleAge(story.sources.map(source => source.publishedAt), editionDay, windowHours);
    if (!freshest) continue;
    const own = sourceAgeDays(story.sources.find(source => source.url === story.primaryUrl)?.publishedAt, editionDay);
    stale[story.primaryUrl] = own ?? freshest;
  }
  return stale;
}
