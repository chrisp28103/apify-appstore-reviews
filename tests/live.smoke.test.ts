import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fetchAppMetadata, fetchReviews } from '../src/scrape.js';

// Opt-in: runs only with LIVE=1. Hits the real Apple endpoints.
const live = process.env.LIVE === '1';
const DUOLINGO = '570060128';

describe('live smoke', { skip: !live && 'set LIVE=1 to run' }, () => {
    it('looks up app metadata', async () => {
        const app = await fetchAppMetadata(DUOLINGO, 'us');
        assert.ok(app, 'app found');
        assert.match(app.name, /duolingo/i);
        assert.ok(app.bundleId);
    });
    it('fetches recent reviews', async () => {
        const reviews = await fetchReviews({ appId: DUOLINGO, country: 'us', maxReviews: 20, sinceDate: null, state: null });
        assert.ok(reviews.length > 0, 'at least one review');
        assert.ok(reviews[0].rating >= 1 && reviews[0].rating <= 5);
        assert.ok(reviews[0].reviewId);
    });
});
