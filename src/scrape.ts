import { log } from 'apify';
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

export interface ReviewResult {
    reviews: ReviewItem[];
    /**
     * True when every new review was fetched: the run reached the cutoff, the state date or the end of the feed.
     * False when maxReviews cut the run short, or a later page failed. Do not move the saved state then.
     */
    complete: boolean;
}

/**
 * Fetch reviews for one app and country, newest first, up to maxReviews.
 * Stops at the first empty page, a 400/404 page, the cutoff date, or MAX_PAGES.
 * Review ids are de-duplicated. A failure after page 1 returns the reviews found so far.
 */
export async function fetchReviewsResult(q: ReviewQuery): Promise<ReviewResult> {
    const out: ReviewItem[] = [];
    if (q.maxReviews <= 0) return { reviews: out, complete: true };
    const seen = new Set<string>();
    const scrapedAt = (q.now?.() ?? new Date()).toISOString();
    const sinceT = q.sinceDate ? q.sinceDate.getTime() : null;
    const stateT = q.state ? new Date(q.state.date).getTime() : null;
    const isOld = (r: ReviewItem): boolean => {
        const t = new Date(r.date).getTime();
        // A review without a valid date cannot be compared. In state mode, treat it as old so it is not charged again.
        if (Number.isNaN(t)) return stateT !== null;
        if (sinceT !== null && t < sinceT) return true;
        if (stateT === null) return false;
        // Same second as the saved review: skip only the saved review itself.
        return t < stateT || (t === stateT && r.reviewId === q.state?.reviewId);
    };
    let complete = true;

    for (let page = 1; page <= MAX_PAGES && out.length < q.maxReviews; page++) {
        let json;
        try {
            json = await fetchJson(reviewsUrl(q.appId, q.country, page), q.fetchOptions);
        } catch (err) {
            if (err instanceof HttpError && (err.status === 400 || err.status === 404)) {
                // Apple answers 400/404 for pages past the end, or for a store without a feed.
                if (page === 1) log.warning(`${q.appId}/${q.country}: no review feed for this store.`);
                break;
            }
            if (page > 1) {
                const msg = err instanceof Error ? err.message : String(err);
                log.warning(`${q.appId}/${q.country}: page ${page} failed (${msg}). Keeping ${out.length} reviews from earlier pages.`);
                complete = false;
                break;
            }
            throw err;
        }
        const reviews = normaliseReviewsFeed(json, q.appId, q.country, scrapedAt);
        if (reviews.length === 0) break;

        let reachedCutoff = false;
        for (let i = 0; i < reviews.length; i++) {
            const review = reviews[i];
            if (isOld(review)) {
                reachedCutoff = true;
                continue;
            }
            if (seen.has(review.reviewId)) continue;
            seen.add(review.reviewId);
            out.push(review);
            if (out.length >= q.maxReviews) {
                const rest = reviews.slice(i + 1);
                // More new reviews may exist on this page or on the next page.
                if (rest.some((r) => !isOld(r)) || (rest.length === 0 && page < MAX_PAGES)) complete = false;
                break;
            }
        }
        if (reachedCutoff) break; // feed is newest first, so everything after is older
    }
    return { reviews: out, complete };
}

/** Same as fetchReviewsResult, but returns only the reviews. */
export async function fetchReviews(q: ReviewQuery): Promise<ReviewItem[]> {
    return (await fetchReviewsResult(q)).reviews;
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
