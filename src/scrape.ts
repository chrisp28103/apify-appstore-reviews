import { fetchJson, HttpError, lookupUrl, reviewsUrl, type FetchOptions } from './fetch.js';
import { normaliseLookup, normaliseReviewsFeed } from './normalise.js';
import type { AppItem, AppState, ReviewItem } from './types.js';

export const MAX_PAGES = 10;

export interface ReviewQuery {
    appId: string;
    country: string;
    maxReviews: number;
    sinceDate: Date | null;
    /** Newest review seen on an earlier run. Used when onlyNewReviews is on. */
    state: AppState | null;
    fetchOptions?: FetchOptions;
    now?: () => Date;
}

/**
 * Fetch reviews for one app and country, newest first, up to maxReviews.
 * Stops at the first empty page, a 400/404 page, the cutoff date, or MAX_PAGES.
 * Review ids are de-duplicated.
 */
export async function fetchReviews(q: ReviewQuery): Promise<ReviewItem[]> {
    const out: ReviewItem[] = [];
    if (q.maxReviews <= 0) return out;
    const seen = new Set<string>();
    const scrapedAt = (q.now?.() ?? new Date()).toISOString();
    const sinceT = q.sinceDate ? q.sinceDate.getTime() : null;
    const stateT = q.state ? new Date(q.state.date).getTime() : null;
    const isOld = (r: ReviewItem): boolean => {
        const t = new Date(r.date).getTime();
        if (Number.isNaN(t)) return false;
        return (sinceT !== null && t < sinceT) || (stateT !== null && t <= stateT);
    };

    for (let page = 1; page <= MAX_PAGES && out.length < q.maxReviews; page++) {
        let json;
        try {
            json = await fetchJson(reviewsUrl(q.appId, q.country, page), q.fetchOptions);
        } catch (err) {
            // Apple answers 400/404 for pages past the end, or for apps without a feed in this store.
            if (err instanceof HttpError && (err.status === 400 || err.status === 404) && page > 1) break;
            throw err;
        }
        const reviews = normaliseReviewsFeed(json, q.appId, q.country, scrapedAt);
        if (reviews.length === 0) break;

        let reachedCutoff = false;
        for (const review of reviews) {
            if (isOld(review)) {
                reachedCutoff = true;
                continue;
            }
            if (seen.has(review.reviewId)) continue;
            seen.add(review.reviewId);
            out.push(review);
            if (out.length >= q.maxReviews) break;
        }
        if (reachedCutoff) break; // feed is newest first, so everything after is older
    }
    return out;
}

/** Fetch metadata for one app and country. Returns null if the store has no such app. */
export async function fetchAppMetadata(
    appId: string,
    country: string,
    fetchOptions?: FetchOptions,
    now: () => Date = () => new Date(),
): Promise<AppItem | null> {
    const json = await fetchJson(lookupUrl(appId, country), fetchOptions);
    return normaliseLookup(json, appId, country, now().toISOString());
}

/** Pick the newest review of a list (by date) as the new state. */
export function newestState(reviews: ReviewItem[]): AppState | null {
    let best: ReviewItem | null = null;
    for (const r of reviews) {
        if (!r.date) continue;
        if (!best || new Date(r.date) > new Date(best.date)) best = r;
    }
    return best ? { reviewId: best.reviewId, date: best.date } : null;
}
