// filterCovered is pure when the ledger entries are injected, so no workspace is needed.
import test from "node:test";
import assert from "node:assert/strict";
import type { HarvestItem, LedgerEntry } from "../types.js";
import { coverageUrlKey, filterCovered, applyPreviewed } from "./ledger.js";

const day = 86400_000;
const ago = (days: number) => new Date(Date.now() - days * day).toISOString();
const entry = (over: Partial<LedgerEntry>): LedgerEntry => ({ id: "e", headline: "h", urls: [], repo: null, coveredAt: ago(1), status: "previewed", posts: {}, ...over });
const item = (id: string, url: string, repo: string | null = null): HarvestItem => ({ id, source: "rss:x", title: id, url, score: 1, publishedAt: "2026-01-01T00:00:00Z", repo, summary: "" }) as HarvestItem;
const ids = (items: HarvestItem[]) => items.map((i) => i.id);

test("the same link is suppressed through tracking params, fragment, host case and trailing slash", () => {
  const entries = [entry({ urls: ["https://News.Example.org/a/story/?utm_source=x&utm_medium=y#top"] })];
  const out = filterCovered([item("same", "https://news.example.org/a/story"), item("other", "https://news.example.org/a/other")], 30, entries);
  assert.deepEqual(ids(out), ["other"]);
});

test("a shared host or repository never suppresses a different article", () => {
  const entries = [entry({ urls: ["https://github.com/acme/tool/releases/tag/v1"], repo: "acme/tool" })];
  const out = filterCovered([item("same-repo", "https://github.com/acme/tool/releases/tag/v2", "acme/tool"), item("same-host", "https://github.com/acme/other")], 30, entries);
  assert.deepEqual(ids(out), ["same-repo", "same-host"]);
});

test("query parameters that identify content are kept, so different videos are different stories", () => {
  assert.notEqual(coverageUrlKey("https://youtube.com/watch?v=A"), coverageUrlKey("https://youtube.com/watch?v=B"));
  assert.equal(coverageUrlKey("https://x.org/p?b=2&a=1&utm_campaign=z"), coverageUrlKey("https://x.org/p/?a=1&b=2"));
});

test("only entries inside the window count", () => {
  const entries = [entry({ urls: ["https://x.org/old"], coveredAt: ago(45) }), entry({ urls: ["https://x.org/new"], coveredAt: ago(5) })];
  const both = [item("old", "https://x.org/old"), item("new", "https://x.org/new")];
  assert.deepEqual(ids(filterCovered(both, 30, entries)), ["old"]);
  assert.deepEqual(ids(filterCovered(both, 60, entries)), []);
});

test("only previewed and posted entries cover a story; a reservation or rejected draft does not", () => {
  for (const status of ["selected", "rejected"] as const) assert.deepEqual(ids(filterCovered([item("a", "https://x.org/a")], 30, [entry({ status, urls: ["https://x.org/a"] })])), ["a"], status);
  for (const status of ["previewed", "posted"] as const) assert.deepEqual(ids(filterCovered([item("a", "https://x.org/a")], 30, [entry({ status, urls: ["https://x.org/a"] })])), [], status);
});

test("an unparseable coveredAt or URL never suppresses anything it cannot prove", () => {
  const out = filterCovered([item("a", "https://x.org/a")], 30, [entry({ coveredAt: "not a date", urls: ["https://x.org/a"] }), entry({ urls: ["not a url"] })]);
  assert.deepEqual(ids(out), ["a"]);
});

test("applyPreviewed upgrades a reservation, refreshes coveredAt, never downgrades posted, ignores unknown ids", () => {
  const now = new Date();
  const ledger = { entries: [entry({ id: "r", status: "selected", coveredAt: ago(3) }), entry({ id: "p", status: "posted", coveredAt: ago(3) })] };
  assert.equal(applyPreviewed(ledger, "r", now), true);
  assert.deepEqual([ledger.entries[0]!.status, ledger.entries[0]!.coveredAt], ["previewed", now.toISOString()]);
  assert.equal(applyPreviewed(ledger, "p", now), false);
  assert.equal(ledger.entries[1]!.status, "posted");
  assert.equal(applyPreviewed(ledger, "missing", now), false);
});

test("a previewed edition suppresses its own stories in the next harvest", () => {
  const ledger = { entries: [entry({ id: "r", status: "selected", urls: ["https://x.org/a"] })] };
  assert.deepEqual(ids(filterCovered([item("a", "https://x.org/a")], 30, ledger.entries)), ["a"]);
  applyPreviewed(ledger, "r");
  assert.deepEqual(ids(filterCovered([item("a", "https://x.org/a")], 30, ledger.entries)), []);
});
