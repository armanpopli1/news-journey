import { join } from "node:path";
import type { HarvestItem, Ledger, LedgerEntry } from "../types.js";
import { STATE_DIR, readJson, writeJson } from "../util.js";

const LEDGER_PATH = join(STATE_DIR, "ledger.json");

export function loadLedger(): Ledger {
  return readJson<Ledger>(LEDGER_PATH, { entries: [] });
}

export function saveLedger(ledger: Ledger): void {
  writeJson(LEDGER_PATH, ledger);
}

export function addEntry(entry: LedgerEntry): void {
  const ledger = loadLedger();
  ledger.entries.push(entry);
  saveLedger(ledger);
}

export function updateEntry(id: string, patch: Partial<LedgerEntry>): void {
  const ledger = loadLedger();
  const e = ledger.entries.find((x) => x.id === id);
  if (e) {
    Object.assign(e, patch);
    saveLedger(ledger);
  }
}

/** An edition that reached review counts as covered from now on, whether or not this tool ever delivers it: someone
 * who sends the text themselves never produces a publication receipt, so without this the window only sees
 * "selected" reservations. Never downgrades "posted". A missing entry is left alone (selection owns creating it). */
export function applyPreviewed(ledger: Ledger, id: string, now = new Date()): boolean {
  const e = ledger.entries.find((x) => x.id === id);
  if (!e || e.status === "posted") return false;
  e.status = "previewed";
  e.coveredAt = now.toISOString();
  return true;
}

export function markPreviewed(id: string): void {
  const ledger = loadLedger();
  if (applyPreviewed(ledger, id)) saveLedger(ledger);
}

export function recentEntries(days: number): LedgerEntry[] {
  const cutoff = Date.now() - days * 86400_000;
  return loadLedger().entries.filter((e) => new Date(e.coveredAt).getTime() > cutoff);
}

/** Ledger states that mean the person was actually shown the story. "selected" is only a reservation (the run may
 * have failed before anything was written) and "rejected" is a verdict on one draft, not on its stories, so neither
 * hides a story from the next edition. */
const COVERING: ReadonlySet<LedgerEntry["status"]> = new Set(["previewed", "posted"]);

const TRACKING_PARAM = /^(utm_[a-z0-9_]+|fbclid|gclid|mc_[a-z]+|ref_src)$/i;

/** Identity key for suppression. Not `normalizeUrl`: that helper drops every query parameter, which is fine for
 * "have we seen this link" bookkeeping but would make `watch?v=A` and `watch?v=B` the same story here. Suppression
 * must only ever err toward keeping a candidate, so only known tracking parameters, the fragment, host case and a
 * trailing slash are ignored; any other parameter is part of the identity. */
export function coverageUrlKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(key)) u.searchParams.delete(key);
    u.searchParams.sort();
    u.pathname = u.pathname.replace(/\/+$/, "") || "/";
    return u.toString(); // URL already lowercases scheme and host
  } catch {
    return url.trim();
  }
}

/** Drop a harvest candidate only when its exact normalized URL (see `coverageUrlKey`) was already covered inside the window.
 *
 * This is deliberately URL identity and nothing wider. The same article is not the same event, and harvest metadata
 * cannot establish event identity: a shared repository or host never suppresses a story, and a different article about
 * an event we already covered stays eligible. Event-level comparison happens later, against complete source packets
 * (`checkStoryCoverage` in memory/runtime.ts). This only stops an identical link from being offered twice.
 * `entries` is injectable so the rule can be tested without a workspace on disk. */
export function filterCovered(items: HarvestItem[], days: number, entries: LedgerEntry[] = recentEntries(days)): HarvestItem[] {
  const covered = new Set<string>();
  const cutoff = Date.now() - days * 86400_000;
  for (const e of entries) {
    if (!COVERING.has(e.status) || !(new Date(e.coveredAt).getTime() > cutoff)) continue;
    for (const url of e.urls) covered.add(coverageUrlKey(url));
  }
  return items.filter((item) => !covered.has(coverageUrlKey(item.url)));
}
