import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fetchJson, HttpError, mapLimit, reviewsUrl, reviewsUrlAlt } from '../src/fetch.js';
import { addAppFields, normaliseLookup, normaliseReviewsFeed } from '../src/normalise.js';
import { parseAppId, parseBundleId, parseCountry, resolveInput, shouldEmitAppRows } from '../src/parse.js';
import { fetchReviews, fetchReviewsResult, matchesFilters, newestState, nextState } from '../src/scrape.js';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const NOW = '2026-10-06T00:00:00.000Z';

describe('parseAppId', () => {
    it('accepts numeric ids, id prefix and URLs', () => {
        assert.equal(parseAppId('389801252'), '389801252');
        assert.equal(parseAppId('id389801252'), '389801252');
        assert.equal(parseAppId(' ID389801252 '), '389801252');
        assert.equal(parseAppId('https://apps.apple.com/us/app/duolingo/id570060128'), '570060128');
        assert.equal(parseAppId('https://apps.apple.com/us/app/duolingo/id570060128?mt=8'), '570060128');
        assert.equal(parseAppId('https://itunes.apple.com/app?id=123'), '123');
    });
    it('rejects junk', () => {
        assert.equal(parseAppId('hello'), null);
        assert.equal(parseAppId(''), null);
        assert.equal(parseAppId(null), null);
    });
});

describe('parseCountry', () => {
    it('validates 2-letter codes', () => {
        assert.equal(parseCountry('US'), 'us');
        assert.equal(parseCountry('usa'), null);
        assert.equal(parseCountry('u1'), null);
    });
});

describe('resolveInput', () => {
    it('applies defaults and de-duplicates', () => {
        const r = resolveInput({ apps: ['123', 'id123', 'bad'] });
        assert.deepEqual(r.appIds, ['123']);
        assert.deepEqual(r.countries, ['us']);
        assert.equal(r.maxReviewsPerApp, 100);
        assert.equal(r.includeMetadata, false);
        assert.equal(r.warnings.length, 1);
    });
    it('clamps maxReviewsPerApp to 500', () => {
        assert.equal(resolveInput({ apps: ['1'], maxReviewsPerApp: 9999 }).maxReviewsPerApp, 500);
    });
    it('throws on no valid app, bad date', () => {
        assert.throws(() => resolveInput({ apps: ['x'] }));
        assert.throws(() => resolveInput({ apps: ['1'], sinceDate: 'nope' }));
        assert.throws(() => resolveInput({ apps: ['1'], countries: ['usa'] }));
    });
});

describe('normaliseReviewsFeed', () => {
    it('maps review fields from a real feed page', () => {
        const items = normaliseReviewsFeed(fixture('reviews-page1.json'), '389801252', 'us', NOW);
        assert.equal(items.length, 4);
        const r = items[0];
        assert.equal(r.type, 'review');
        assert.equal(r.appId, '389801252');
        assert.equal(typeof r.rating, 'number');
        assert.ok(r.reviewId.length > 0);
        assert.ok(!Number.isNaN(Date.parse(r.date)));
        assert.equal(r.scrapedAt, NOW);
    });
    it('handles a single entry object', () => {
        const items = normaliseReviewsFeed(fixture('reviews-single-entry.json'), '1', 'us', NOW);
        assert.equal(items.length, 1);
    });
    it('handles an empty feed and garbage', () => {
        assert.deepEqual(normaliseReviewsFeed(fixture('reviews-empty.json'), '1', 'us', NOW), []);
        assert.deepEqual(normaliseReviewsFeed(null, '1', 'us', NOW), []);
    });
    it('skips the app info entry (no rating)', () => {
        const feed = fixture('reviews-page1.json');
        feed.feed.entry.unshift({ 'im:name': { label: 'App' }, id: { label: 'https://apps.apple.com/app' } });
        assert.equal(normaliseReviewsFeed(feed, '1', 'us', NOW).length, 4);
    });
});

describe('normaliseLookup', () => {
    it('maps app metadata', () => {
        const app = normaliseLookup(fixture('lookup.json'), '389801252', 'us', NOW);
        assert.ok(app);
        assert.equal(app.type, 'app');
        assert.equal(app.appId, '389801252');
        assert.ok(app.name.length > 0);
        assert.ok(Array.isArray(app.genres));
    });
    it('returns null when not found', () => {
        assert.equal(normaliseLookup({ resultCount: 0, results: [] }, '1', 'us', NOW), null);
    });
});

const res = (status: number, body = '') => new Response(body, { status });

describe('fetchJson', () => {
    const sleep = async () => {};
    it('retries 5xx then succeeds', async () => {
        let calls = 0;
        const fetchImpl = (async () => (++calls < 3 ? res(503) : res(200, '{"ok":1}'))) as typeof fetch;
        assert.deepEqual(await fetchJson('u', { fetchImpl, sleep }), { ok: 1 });
        assert.equal(calls, 3);
    });
    it('retries network errors, then throws after 3 tries', async () => {
        let calls = 0;
        const fetchImpl = (async () => {
            calls++;
            throw new TypeError('fetch failed');
        }) as typeof fetch;
        await assert.rejects(fetchJson('u', { fetchImpl, sleep }), /fetch failed/);
        assert.equal(calls, 3);
    });
    it('does not retry 404', async () => {
        let calls = 0;
        const fetchImpl = (async () => (calls++, res(404))) as typeof fetch;
        await assert.rejects(fetchJson('u', { fetchImpl, sleep }), (e: unknown) => e instanceof HttpError && e.status === 404);
        assert.equal(calls, 1);
    });
    it('backs off exponentially', async () => {
        const delays: number[] = [];
        const fetchImpl = (async () => res(429)) as typeof fetch;
        await assert.rejects(
            fetchJson('u', { fetchImpl, baseDelayMs: 100, sleep: async (ms) => void delays.push(ms) }),
        );
        assert.deepEqual(delays, [100, 200]);
    });
    it('returns null for an empty body', async () => {
        const fetchImpl = (async () => res(200, '')) as typeof fetch;
        assert.equal(await fetchJson('u', { fetchImpl, sleep }), null);
    });
});

describe('mapLimit', () => {
    it('settles every item and respects the limit', async () => {
        let active = 0;
        let peak = 0;
        const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
            active++;
            peak = Math.max(peak, active);
            await new Promise((r) => setTimeout(r, 5));
            active--;
            if (n === 3) throw new Error('boom');
            return n;
        });
        assert.equal(peak, 2);
        assert.equal(out.filter((o) => o.status === 'rejected').length, 1);
        assert.equal(out.filter((o) => o.status === 'fulfilled').length, 4);
    });
});

/** Build a fake feed page of n reviews with ids and descending dates. */
function fakePage(start: number, n: number) {
    const entry = Array.from({ length: n }, (_, i) => {
        const k = start + i;
        return {
            id: { label: `r${k}` },
            'im:rating': { label: '5' },
            title: { label: `t${k}` },
            content: { label: 'c' },
            updated: { label: new Date(Date.UTC(2026, 0, 1) - k * 3600_000).toISOString() },
            author: { name: { label: 'a' } },
        };
    });
    return { feed: { entry } };
}

describe('fetchReviews', () => {
    const pages = (map: Record<number, unknown>) =>
        (async (url: string) => {
            const page = Number(/page=(\d+)/.exec(String(url))![1]);
            if (!(page in map)) return res(400);
            return res(200, JSON.stringify(map[page]));
        }) as unknown as typeof fetch;
    const base = { appId: '1', country: 'us', sinceDate: null, state: null };

    it('pages until maxReviews and de-duplicates ids', async () => {
        const fetchImpl = pages({ 1: fakePage(0, 50), 2: fakePage(40, 50), 3: fakePage(90, 50) });
        const out = await fetchReviews({ ...base, maxReviews: 120, fetchOptions: { fetchImpl } });
        assert.equal(out.length, 120);
        assert.equal(new Set(out.map((r) => r.reviewId)).size, 120);
    });
    it('stops on a 400 past the last page', async () => {
        const fetchImpl = pages({ 1: fakePage(0, 50), 2: fakePage(50, 10) });
        const out = await fetchReviews({ ...base, maxReviews: 500, fetchOptions: { fetchImpl } });
        assert.equal(out.length, 60);
    });
    it('returns nothing for an empty feed', async () => {
        const fetchImpl = pages({ 1: { feed: {} } });
        assert.deepEqual(await fetchReviews({ ...base, maxReviews: 50, fetchOptions: { fetchImpl } }), []);
    });
    it('throws on a 403 at page 1', async () => {
        const fetchImpl = (async () => res(403)) as typeof fetch;
        await assert.rejects(fetchReviews({ ...base, maxReviews: 50, fetchOptions: { fetchImpl, sleep: async () => {} } }));
    });
    it('filters by sinceDate', async () => {
        const fetchImpl = pages({ 1: fakePage(0, 50) });
        const since = new Date(Date.UTC(2026, 0, 1) - 9.5 * 3600_000); // keeps r0..r9
        const out = await fetchReviews({ ...base, maxReviews: 50, sinceDate: since, fetchOptions: { fetchImpl } });
        assert.equal(out.length, 10);
    });
    it('returns only reviews newer than state', async () => {
        const fetchImpl = pages({ 1: fakePage(0, 50) });
        const all = await fetchReviews({ ...base, maxReviews: 50, fetchOptions: { fetchImpl } });
        const state = newestState(all.slice(5));
        assert.ok(state);
        const out = await fetchReviews({ ...base, maxReviews: 50, state, fetchOptions: { fetchImpl } });
        assert.deepEqual(out.map((r) => r.reviewId), ['r0', 'r1', 'r2', 'r3', 'r4']);
    });
});

describe('newestState', () => {
    it('returns null for empty input', () => assert.equal(newestState([]), null));
});

describe('fetchReviewsResult and state safety', () => {
    const pages = (map: Record<number, unknown>, failFrom = 99) =>
        (async (url: string) => {
            const page = Number(/page=(\d+)/.exec(String(url))![1]);
            if (page >= failFrom) return res(500);
            if (!(page in map)) return res(400);
            return res(200, JSON.stringify(map[page]));
        }) as unknown as typeof fetch;
    const base = { appId: '1', country: 'us', sinceDate: null, state: null };
    const fo = (fetchImpl: typeof fetch) => ({ fetchImpl, retries: 1, sleep: async () => {} });

    it('marks the result incomplete when maxReviews cuts the run', async () => {
        const r = await fetchReviewsResult({ ...base, maxReviews: 20, fetchOptions: fo(pages({ 1: fakePage(0, 50) })) });
        assert.equal(r.reviews.length, 20);
        assert.equal(r.complete, false);
    });
    it('marks the result complete when the feed ends', async () => {
        const r = await fetchReviewsResult({ ...base, maxReviews: 500, fetchOptions: fo(pages({ 1: fakePage(0, 10) })) });
        assert.equal(r.complete, true);
    });
    it('keeps earlier pages when a later page fails', async () => {
        const r = await fetchReviewsResult({ ...base, maxReviews: 500, fetchOptions: fo(pages({ 1: fakePage(0, 50), 2: fakePage(50, 50) }, 2)) });
        assert.equal(r.reviews.length, 50);
        assert.equal(r.complete, false);
    });
    it('returns an empty list on a 400 at page 1', async () => {
        const r = await fetchReviewsResult({ ...base, maxReviews: 50, fetchOptions: fo(pages({})) });
        assert.deepEqual(r, { reviews: [], complete: true, newestSeen: null });
    });
    it('maps uk to gb with a warning', () => {
        const r = resolveInput({ apps: ['1'], countries: ['uk'] });
        assert.deepEqual(r.countries, ['gb']);
        assert.equal(r.warnings.length, 1);
    });
});

describe('sort option', () => {
    it('puts sortby in both feed URLs', () => {
        assert.match(reviewsUrl('1', 'us', 2), /sortby=mostrecent/);
        assert.match(reviewsUrl('1', 'us', 2, 'mosthelpful'), /sortby=mosthelpful/);
        assert.match(reviewsUrlAlt('1', 'us', 2, 'mosthelpful'), /sortby=mosthelpful.*cc=us/);
    });
    it('defaults to mostrecent and ignores onlyNewReviews with mosthelpful', () => {
        assert.equal(resolveInput({ apps: ['1'] }).sort, 'mostrecent');
        const r = resolveInput({ apps: ['1'], sort: 'mosthelpful', onlyNewReviews: true });
        assert.equal(r.onlyNewReviews, false);
        assert.equal(r.warnings.length, 1);
    });
});

const pagesOf = (map: Record<number, unknown>, urls: string[] = []) =>
    (async (url: string) => {
        urls.push(String(url));
        const page = Number(/page=(\d+)/.exec(String(url))![1]);
        if (!(page in map)) return res(400);
        return res(200, JSON.stringify(map[page]));
    }) as unknown as typeof fetch;
const baseQ = { appId: '1', country: 'us', sinceDate: null, state: null };

describe('mosthelpful and the cutoff', () => {
    it('does not stop at an old review', async () => {
        const page = fakePage(0, 10);
        // Put an old review in the middle of the page, as a helpful-sorted feed can.
        page.feed.entry[2].updated.label = '2020-01-01T00:00:00.000Z';
        const urls: string[] = [];
        const fetchImpl = pagesOf({ 1: page, 2: fakePage(50, 5) }, urls);
        const since = new Date('2025-01-01T00:00:00Z');
        const helpful = await fetchReviews({ ...baseQ, maxReviews: 100, sinceDate: since, sort: 'mosthelpful', fetchOptions: { fetchImpl } });
        assert.equal(helpful.length, 14); // 9 on page 1, 5 on page 2
        assert.ok(urls.every((u) => u.includes('sortby=mosthelpful')));
        const recent = await fetchReviews({ ...baseQ, maxReviews: 100, sinceDate: since, fetchOptions: { fetchImpl } });
        assert.equal(recent.length, 9); // stops after page 1
    });
});

describe('rating and keyword filters', () => {
    const feedWith = (rows: Array<[string, number, string]>) => ({
        feed: {
            entry: rows.map(([id, rating, text], i) => ({
                id: { label: id },
                'im:rating': { label: String(rating) },
                title: { label: 'T' },
                content: { label: text },
                updated: { label: new Date(Date.UTC(2026, 0, 1) - i * 1000).toISOString() },
                author: { name: { label: 'a' } },
            })),
        },
    });
    it('validates ratings and keywords', () => {
        assert.throws(() => resolveInput({ apps: ['1'], minRating: 4, maxRating: 2 }), /minRating/);
        assert.throws(() => resolveInput({ apps: ['1'], minRating: 0 }));
        assert.throws(() => resolveInput({ apps: ['1'], maxRating: 6 }));
        const r = resolveInput({ apps: ['1'], minRating: 2, keywords: [' Crash ', '', 'crash'] });
        assert.deepEqual(r.keywords, ['crash']);
        assert.equal(r.minRating, 2);
        assert.equal(r.maxRating, null);
    });
    it('matchesFilters checks stars and any keyword, case-insensitive', () => {
        const r = normaliseReviewsFeed(feedWith([['a', 3, 'App CRASHES daily']]), '1', 'us', NOW)[0];
        assert.equal(matchesFilters(r, { minRating: 3, maxRating: 3, keywords: ['crash'] }), true);
        assert.equal(matchesFilters(r, { minRating: 4 }), false);
        assert.equal(matchesFilters(r, { maxRating: 2 }), false);
        assert.equal(matchesFilters(r, { keywords: ['login', 'daily'] }), true);
        assert.equal(matchesFilters(r, { keywords: ['login'] }), false);
    });
    it('does not count filtered reviews toward max and keeps reading pages', async () => {
        const p1 = feedWith(Array.from({ length: 5 }, (_, i) => [`a${i}`, 1, 'x'] as [string, number, string]));
        const p2 = feedWith(Array.from({ length: 5 }, (_, i) => [`b${i}`, 5, 'x'] as [string, number, string]));
        p2.feed.entry.forEach((e) => (e.updated.label = '2025-12-01T00:00:00.000Z'));
        const r = await fetchReviewsResult({ ...baseQ, maxReviews: 3, minRating: 5, fetchOptions: { fetchImpl: pagesOf({ 1: p1, 2: p2 }) } });
        assert.deepEqual(r.reviews.map((x) => x.reviewId), ['b0', 'b1', 'b2']);
        assert.equal(r.complete, false); // b3 and b4 still match
    });
    it('state follows the newest review seen, matching or not', async () => {
        const p1 = feedWith([['n1', 1, 'x'], ['n2', 5, 'x'], ['n3', 1, 'x']]);
        const done = await fetchReviewsResult({ ...baseQ, maxReviews: 5, minRating: 5, fetchOptions: { fetchImpl: pagesOf({ 1: p1 }) } });
        assert.deepEqual(done.reviews.map((x) => x.reviewId), ['n2']);
        assert.equal(done.complete, true);
        assert.equal(done.newestSeen?.reviewId, 'n1'); // n1 is no match, but it is the newest seen
    });
    it('onlyNewReviews: the next run skips filtered reviews', async () => {
        const p1 = feedWith([['n1', 1, 'x'], ['n2', 5, 'x'], ['n3', 1, 'x']]);
        const first = await fetchReviewsResult({ ...baseQ, maxReviews: 5, minRating: 5, fetchOptions: { fetchImpl: pagesOf({ 1: p1 }) } });
        const saved = nextState(null, first.newestSeen);
        const second = await fetchReviewsResult({ ...baseQ, maxReviews: 5, minRating: 5, state: saved, fetchOptions: { fetchImpl: pagesOf({ 1: p1 }) } });
        assert.deepEqual(second.reviews, []);
        assert.equal(second.complete, true);
        assert.equal(nextState(saved, second.newestSeen), null);
    });
});

describe('403 retry', () => {
    it('retries 403 then succeeds', async () => {
        let calls = 0;
        const fetchImpl = (async () => (++calls < 3 ? res(403) : res(200, '{"ok":1}'))) as typeof fetch;
        assert.deepEqual(await fetchJson('u', { fetchImpl, sleep: async () => {} }), { ok: 1 });
        assert.equal(calls, 3);
    });
});

describe('bundle ids', () => {
    it('parses reverse-DNS bundle ids', () => {
        assert.equal(parseBundleId('com.duolingo.DuolingoMobile'), 'com.duolingo.DuolingoMobile');
        assert.equal(parseBundleId('hello'), null);
        assert.equal(parseBundleId('https://apps.apple.com/us/app/x'), null);
    });
    it('keeps bundle ids apart from numeric ids and de-duplicates them', () => {
        const r = resolveInput({ apps: ['123', 'com.a.b', 'com.a.b', 'junk'] });
        assert.deepEqual(r.appIds, ['123']);
        assert.deepEqual(r.bundleIds, ['com.a.b']);
        assert.equal(r.warnings.length, 1);
        assert.deepEqual(resolveInput({ apps: ['com.a.b'] }).appIds, []);
    });
});

describe('same-second state', () => {
    it('skips every id saved at the state date and keeps a new id at the same date', async () => {
        const entry = (id: string, date: string) => ({
            id: { label: id },
            'im:rating': { label: '5' },
            title: { label: 't' },
            content: { label: 'c' },
            updated: { label: date },
            author: { name: { label: 'a' } },
        });
        const same = '2026-01-01T00:00:00.000Z';
        const feed = { feed: { entry: [entry('x3', same), entry('x2', same), entry('x1', same), entry('x0', '2025-12-31T00:00:00.000Z')] } };
        const state = { reviewId: 'x1', date: same, idsAtDate: ['x1', 'x2'] };
        const r = await fetchReviewsResult({ ...baseQ, maxReviews: 10, state, fetchOptions: { fetchImpl: pagesOf({ 1: feed }) } });
        assert.deepEqual(r.reviews.map((x) => x.reviewId), ['x3']);
        const next = nextState(state, r.newestSeen);
        assert.deepEqual(next?.idsAtDate?.sort(), ['x1', 'x2', 'x3']);
        // Old state without idsAtDate: only the saved reviewId is skipped.
        const old = await fetchReviewsResult({ ...baseQ, maxReviews: 10, state: { reviewId: 'x1', date: same }, fetchOptions: { fetchImpl: pagesOf({ 1: feed }) } });
        assert.deepEqual(old.reviews.map((x) => x.reviewId), ['x3', 'x2']);
    });
    it('newestState fills idsAtDate', () => {
        const mk = (id: string, date: string) => ({ reviewId: id, date }) as never;
        const s = newestState([mk('a', '2026-01-01T00:00:00.000Z'), mk('b', '2026-01-02T00:00:00.000Z'), mk('c', '2026-01-02T00:00:00.000Z')]);
        assert.deepEqual(s?.idsAtDate, ['b', 'c']);
    });
});

describe('app fields and app rows', () => {
    it('emits app rows only for metadata-only runs', () => {
        assert.equal(shouldEmitAppRows(true, 0), true);
        assert.equal(shouldEmitAppRows(true, 100), false);
        assert.equal(shouldEmitAppRows(false, 0), false);
    });
    it('copies app fields onto a review, null when no lookup', () => {
        const review = normaliseReviewsFeed(fixture('reviews-single-entry.json'), '1', 'us', NOW)[0];
        const app = normaliseLookup(fixture('lookup.json'), '389801252', 'us', NOW);
        addAppFields(review, app, 'mosthelpful');
        assert.equal(review.appName, app?.name);
        assert.equal(review.appDeveloper, app?.developer);
        assert.equal(review.appUrl, app?.url);
        assert.equal(review.sort, 'mosthelpful');
        addAppFields(review, null, 'mostrecent');
        assert.equal(review.appDeveloper, null);
        assert.equal(review.appAverageRating, null);
    });
});
