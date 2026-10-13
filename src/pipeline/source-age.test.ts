import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_EDITION_WINDOW_HOURS, EDITION_RELATIVE_PHRASES, freshestStaleAge, isOutsideWindow, reportedMarker, sourceAgeDays, staleEditionWording, staleStoryAges } from './source-age.js';
import { editionWindowHours } from './edition-window.js';
import { newsletterStaleDays, renderedNewsletterOutputs } from './newsletter.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Topic } from '../types.js';
import type { NewsletterData } from './newsletter-html.js';

const DAY = '2026-10-14';

test('source age counts whole calendar days and an unknown or future date is never stale', () => {
  assert.deepEqual(sourceAgeDays('2026-10-11T23:59:59Z', DAY), { publishedOn: '2026-10-11', days: 3 });
  assert.equal(sourceAgeDays(null, DAY), null);
  assert.equal(sourceAgeDays('not a date', DAY), null);
  assert.equal(isOutsideWindow(sourceAgeDays('2026-10-11', DAY), 72), false, 'three days is exactly the 72-hour window');
  assert.equal(isOutsideWindow(sourceAgeDays('2026-10-10', DAY), 72), true);
  assert.equal(isOutsideWindow(sourceAgeDays('2026-10-15', DAY), 72), false, 'a source dated after the edition is not old');
  assert.equal(isOutsideWindow(null, 72), false);
});

test('the phrase list names the wording the guard looks for', () => {
  assert.deepEqual([...EDITION_RELATIVE_PHRASES], ['this week', 'today', 'yesterday', 'tomorrow', 'upcoming', 'next month']);
});

test('edition-relative wording is a finding only when every cited source is dated and outside the window', () => {
  const old = ['2026-09-01', '2026-09-02'];
  const text = 'The board published its plan this week and will hold an upcoming vote. It said Today it will act. Reported on USA Today.';
  const finding = staleEditionWording(text, old, DAY, 72)!;
  assert.match(finding, /"this week", "upcoming", "today"/);
  assert.match(finding, /2026-09-02, 42 days before the 2026-10-14 edition/, 'reports the freshest source');
  assert.match(finding, /72-hour window/);
  for (const phrase of EDITION_RELATIVE_PHRASES) assert.match(staleEditionWording(`It happens ${phrase}.`, old, DAY, 72) ?? '', new RegExp(`"${phrase}"`), phrase);
  assert.equal(staleEditionWording('It was reported by USA Today.', old, DAY, 72), null, 'an outlet name is not a date');
  assert.equal(staleEditionWording('The board published its plan on September 1.', old, DAY, 72), null, 'no relative wording, no finding');
  assert.equal(staleEditionWording(text, ['2026-09-01', '2026-10-13'], DAY, 72), null, 'one fresh source can justify the wording');
  assert.equal(staleEditionWording(text, ['2026-09-01', null], DAY, 72), null, 'an undated source leaves the call to the reviewers');
  assert.equal(staleEditionWording(text, [], DAY, 72), null);
  assert.equal(staleEditionWording(text, old, DAY, 24 * 60), null, 'a wide window tolerates the same sources');
});

test('the freshest stale source sets the story age', () => {
  assert.deepEqual(freshestStaleAge(['2026-09-01', '2026-09-20'], DAY, 72), { publishedOn: '2026-09-20', days: 24 });
  assert.equal(freshestStaleAge(['2026-09-01', '2026-10-13'], DAY, 72), null);
});

test('window follows the enabled sources: the widest of RSS (72 h) and Hacker News', () => {
  assert.equal(editionWindowHours(), DEFAULT_EDITION_WINDOW_HOURS);
  assert.equal(editionWindowHours({ enabledSources: ['hn', 'githubTrending', 'rss'], hn: { windowHours: 48 } }), 72);
  assert.equal(editionWindowHours({ enabledSources: ['hn'], hn: { windowHours: 48 } }), 48);
  assert.equal(editionWindowHours({ enabledSources: ['hn', 'rss'], hn: { windowHours: 168 } }), 168);
  assert.equal(editionWindowHours({ enabledSources: ['githubTrending'] }), DEFAULT_EDITION_WINDOW_HOURS);
  assert.equal(editionWindowHours({ enabledSources: ['hn'], hn: { windowHours: -3 } }), DEFAULT_EDITION_WINDOW_HOURS);
});

test('only stale stories are labelled, with the primary source date when known', () => {
  const stories = [
    { primaryUrl: 'https://a.example.org/old', sources: [{ url: 'https://a.example.org/old', publishedAt: '2026-09-14' }, { url: 'https://b.example.org/also', publishedAt: '2026-09-20T10:00:00Z' }] },
    { primaryUrl: 'https://c.example.org/fresh', sources: [{ url: 'https://c.example.org/fresh', publishedAt: '2026-10-13' }] },
    { primaryUrl: 'https://d.example.org/undated', sources: [{ url: 'https://d.example.org/undated', publishedAt: null }] },
  ];
  assert.deepEqual(staleStoryAges(stories, DAY, 72), { 'https://a.example.org/old': { publishedOn: '2026-09-14', days: 30 } });
});

test('marker is a short date and carries the year only when it differs from the edition', () => {
  assert.equal(reportedMarker({ publishedOn: '2026-09-14' }, DAY), 'reported Sep 14');
  assert.equal(reportedMarker({ publishedOn: '2025-12-30' }, DAY), 'reported Dec 30, 2025');
});

const issue = {
  subject: 'Example', lead: { title: 'Lead story', body: 'The lead body.', sourceName: 'Lead Board', sourceUrl: 'https://lead.example.org/story' },
  items: [{ name: 'Second', url: 'https://second.example.org/story', line: 'The second line.' }, { name: 'Third', url: 'https://third.example.org/story', line: 'The third line.' }],
  radar: [], signals: [],
};
const data = (staleDays?: NewsletterData['staleDays']): NewsletterData => ({
  publisher: { name: 'Example Editor', publication: 'Example Signal', audience: 'Leaders', tone: 'Direct' },
  issue, issueNo: 1, date: DAY, dateLong: 'October 14, 2026', video: null, coveredWeek: [], ...(staleDays ? { staleDays } : {}),
});

test('stale stories carry a reported-date marker next to their citation in every output; fresh ones are untouched', () => {
  const marked = renderedNewsletterOutputs(data({
    'https://lead.example.org/story': { publishedOn: '2026-09-14', days: 30 },
    'https://third.example.org/story': { publishedOn: '2026-09-20', days: 24 },
  }));
  assert.match(marked.markdown, /\(\[Lead Board\]\(https:\/\/lead\.example\.org\/story\), reported Sep 14\)/);
  assert.match(marked.markdown, /The third line\. \(reported Sep 20\)/);
  assert.doesNotMatch(marked.markdown, /The second line\. \(reported/);
  assert.match(marked.linkedin, /Lead Board<\/a>, reported Sep 14\)/);
  assert.match(marked.linkedin, /The third line\. \(reported Sep 20\)/);
  assert.match(marked.web, /Source: Lead Board<\/a> <span class="reported"[^>]*>\(reported Sep 14\)<\/span>/);
  assert.match(marked.web, /The third line\. <span class="reported"[^>]*>\(reported Sep 20\)<\/span>/);
  assert.equal((marked.web.match(/class="reported"/g) ?? []).length, 2);
  for (const output of Object.values(renderedNewsletterOutputs(data()))) assert.doesNotMatch(output, /reported (?:Sep|Oct)/);
});

test('newsletter data labels stale stories from pinned claim evidence, else from the saved Journey editorial input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stale-days-'));
  try {
    const evidence = (url: string, publishedAt: string | null) => ({ url, role: 'primary' as const, status: 200, sha256: null, observedAt: '2026-10-14T05:00:00Z', publishedAt });
    const story = (url: string, claimEvidence?: ReturnType<typeof evidence>[]) => ({ primaryUrl: url, headline: url, ...(claimEvidence ? { claimEvidence } : {}) });
    const topic = { id: '20261014-x', stories: [story('https://old.example.org/a', [evidence('https://old.example.org/a', '2026-09-14')]), story('https://fresh.example.org/b', [evidence('https://fresh.example.org/b', '2026-10-13')]), story('https://journey.example.org/c')] } as unknown as Topic;
    assert.deepEqual(newsletterStaleDays(dir, topic, DAY, 72), { 'https://old.example.org/a': { publishedOn: '2026-09-14', days: 30 } });
    writeFileSync(join(dir, 'journey-editorial-input.json'), JSON.stringify({ input: { stories: [{ primaryUrl: 'https://journey.example.org/c', sources: [{ url: 'https://journey.example.org/c', publishedAt: '2026-08-01T00:00:00Z' }] }] } }));
    assert.deepEqual(Object.keys(newsletterStaleDays(dir, topic, DAY, 72)!).sort(), ['https://journey.example.org/c', 'https://old.example.org/a']);
    assert.equal(newsletterStaleDays(dir, { id: 'x', primaryUrl: 'https://fresh.example.org/b' } as unknown as Topic, DAY, 72), undefined, 'nothing stale, nothing labelled');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
