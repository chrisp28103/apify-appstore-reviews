import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fetchJson, HttpError, mapLimit } from '../src/fetch.js';
import { normaliseLookup, normaliseReviewsFeed } from '../src/normalise.js';
import { parseAppId, parseCountry, resolveInput } from '../src/parse.js';
import { fetchReviews, fetchReviewsResult, newestState } from '../src/scrape.js';

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
        await assert.rejects(fetchReviews({ ...base, maxReviews: 50, fetchOptions: { fetchImpl } }));
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
        assert.deepEqual(r, { reviews: [], complete: true });
    });
    it('maps uk to gb with a warning', () => {
        const r = resolveInput({ apps: ['1'], countries: ['uk'] });
        assert.deepEqual(r.countries, ['gb']);
        assert.equal(r.warnings.length, 1);
    });
});
