import { loadConfig } from '../util.js';
import { DEFAULT_EDITION_WINDOW_HOURS } from './source-age.js';

/** The edition window the harvest actually used: the widest window among the enabled sources that have one.
 * Stock config: RSS (72 h) and Hacker News (hn.windowHours); GitHub trending has no window of its own. */
export function editionWindowHours(sources?: { enabledSources?: string[]; hn?: { windowHours?: number } }): number {
  const enabled = sources?.enabledSources;
  const windows = [
    ...(enabled?.includes('hn') && Number.isFinite(sources?.hn?.windowHours) && sources!.hn!.windowHours! > 0 ? [sources!.hn!.windowHours!] : []),
    ...(enabled?.includes('rss') ? [DEFAULT_EDITION_WINDOW_HOURS] : []),
  ];
  return windows.length ? Math.max(...windows) : DEFAULT_EDITION_WINDOW_HOURS;
}

/** The current workspace's window; an unreadable config means the default, never a failed edition. */
export function currentEditionWindowHours(): number {
  try { return editionWindowHours(loadConfig<{ enabledSources?: string[]; hn?: { windowHours?: number } }>('sources')); }
  catch { return DEFAULT_EDITION_WINDOW_HOURS; }
}
