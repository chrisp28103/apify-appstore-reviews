import { log } from 'apify';
import { bundleLookupUrl, fetchJson, HttpError, lookupUrl, reviewsUrl, reviewsUrlAlt, type FetchOptions } from './fetch.js';
import { toArray } from './parse.js';
import { normaliseLookup, normaliseReviewsFeed } from './normalise.js';
import type { AppItem, AppState, ReviewItem, SortOrder } from './types.js';

export const MAX_PAGES = 10;

export interface ReviewQuery {
    appId: string;
    country: string;
    maxReviews: number;
    sinceDate: Date | null;
    /** Newest review seen on an earlier run. Used when onlyNewReviews is on. */
    state: AppState | null;
    /** Feed sort order. Default mostrecent. */
    sort?: SortOrder;
    minRating?: number | null;
    maxRating?: number | null;
    /** Lower-case keywords. A review matches when its title or text has any of them. */
    keywords?: string[];
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
    /**
     * Newest non-old review the run saw, matching the filters or not, with all ids at that date.
     * Use it as the new saved state: filtered-out new reviews are skipped on purpose.
     */
    newestSeen: AppState | null;
}

/** True when the review passes the star and keyword filters. */
export function matchesFilters(r: ReviewItem, q: Pick<ReviewQuery, 'minRating' | 'maxRating' | 'keywords'>): boolean {
    if (q.minRating && r.rating < q.minRating) return false;
    if (q.maxRating && r.rating > q.maxRating) return false;
    if (q.keywords && q.keywords.length > 0) {
        const haystack = `${r.title}
${r.text}`.toLowerCase();
        if (!q.keywords.some((k) => haystack.includes(k.toLowerCase()))) return false;
    }
    return true;
}

/**
 * Fetch reviews for one app and country, newest first, up to maxReviews.
 * Stops at the first empty page, a 400/404 page, the cutoff date, or MAX_PAGES.
 * Review ids are de-duplicated. A failure after page 1 returns the reviews found so far.
 */
export async function fetchReviewsResult(q: ReviewQuery): Promise<ReviewResult> {
    const out: ReviewItem[] = [];
    if (q.maxReviews <= 0) return { reviews: out, complete: true, newestSeen: null };
    const seen = new Set<string>();
    const seenReviews: ReviewItem[] = [];
    const sort = q.sort ?? 'mostrecent';
    const scrapedAt = (q.now?.() ?? new Date()).toISOString();
    const sinceT = q.sinceDate ? q.sinceDate.getTime() : null;
    const stateT = q.state ? new Date(q.state.date).getTime() : null;
    const isOld = (r: ReviewItem): boolean => {
        const t = new Date(r.date).getTime();
        // A review without a valid date cannot be compared. In state mode, treat it as old so it is not charged again.
        if (Number.isNaN(t)) return stateT !== null;
        if (sinceT !== null && t < sinceT) return true;
        if (stateT === null) return false;
        // Same second as the saved review: skip only the reviews the saved state already holds.
        const savedIds = q.state?.idsAtDate ?? [q.state?.reviewId];
        return t < stateT || (t === stateT && savedIds.includes(r.reviewId));
    };
    let complete = true;

    for (let page = 1; page <= MAX_PAGES && out.length < q.maxReviews; page++) {
        let json;
        try {
            json = await fetchJson(reviewsUrl(q.appId, q.country, page, sort), q.fetchOptions);
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
        let reviews = normaliseReviewsFeed(json, q.appId, q.country, scrapedAt);
        if (reviews.length === 0 && page === 1) {
            // Apple sometimes serves an empty page-1 feed from a cache. Retry on both URL forms before giving up.
            reviews = await retryEmptyFirstPage(q, scrapedAt, json, sort);
        }
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
            seenReviews.push(review);
            if (!matchesFilters(review, q)) continue;
            out.push(review);
            if (out.length >= q.maxReviews) {
                const rest = reviews.slice(i + 1);
                // More new reviews may exist on this page or on the next page.
                if (rest.some((r) => !isOld(r) && matchesFilters(r, q)) || (rest.length === 0 && page < MAX_PAGES)) complete = false;
                break;
            }
        }
        // Only the newest-first feed lets us stop at the cutoff. A most-helpful feed has no date order.
        if (reachedCutoff && sort === 'mostrecent') break;
    }
    return { reviews: out, complete, newestSeen: newestState(seenReviews) };
}

const EMPTY_RETRY_DELAYS_MS = [1500, 4000];

async function retryEmptyFirstPage(q: ReviewQuery, scrapedAt: string, firstJson: unknown, sort: SortOrder): Promise<ReviewItem[]> {
    const sleep = q.fetchOptions?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const urls = [
        reviewsUrlAlt(q.appId, q.country, 1, sort),
        reviewsUrl(q.appId, q.country, 1, sort),
        reviewsUrlAlt(q.appId, q.country, 1, sort),
    ];
    for (let i = 0; i < urls.length; i++) {
        if (i > 0) await sleep(EMPTY_RETRY_DELAYS_MS[i - 1]);
        try {
            const json = await fetchJson(urls[i], q.fetchOptions);
            const reviews = normaliseReviewsFeed(json, q.appId, q.country, scrapedAt);
            if (reviews.length > 0) return reviews;
        } catch {
            // try the next form
        }
    }
    const feed = (firstJson as { feed?: Record<string, unknown> } | null)?.feed;
    const keys = feed ? Object.keys(feed).join(',') : 'no feed';
    log.warning(`${q.appId}/${q.country}: Apple returned an empty review feed on 4 tries (feed keys: ${keys}).`);
    return [];
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

/** Resolve a bundle id to its numeric app id. Returns null if the store has no such app. */
export async function resolveBundleId(bundleId: string, country: string, fetchOptions?: FetchOptions): Promise<string | null> {
    const json = await fetchJson(bundleLookupUrl(bundleId, country), fetchOptions);
    const first = toArray<{ trackId?: unknown }>(json?.results)[0];
    return first && first.trackId !== undefined && first.trackId !== null ? String(first.trackId) : null;
}

/** Pick the newest review of a list (by date) as the new state. It holds every id that shares that date. */
export function newestState(reviews: ReviewItem[]): AppState | null {
    let best: ReviewItem | null = null;
    for (const r of reviews) {
        if (!r.date) continue;
        if (!best || new Date(r.date) > new Date(best.date)) best = r;
    }
    if (!best) return null;
    const idsAtDate = reviews.filter((r) => r.date === best.date).map((r) => r.reviewId);
    return { reviewId: best.reviewId, date: best.date, idsAtDate };
}

/**
 * Decide the state to save after a run. Returns null when the state must not move.
 * It moves when the newest seen review is newer than the saved one, or has the same date with new ids.
 */
export function nextState(previous: AppState | null, newest: AppState | null): AppState | null {
    if (!newest) return null;
    if (!previous) return newest;
    const prevT = new Date(previous.date).getTime();
    const newT = new Date(newest.date).getTime();
    if (newT > prevT) return newest;
    if (newT < prevT) return null;
    const saved = previous.idsAtDate ?? [previous.reviewId];
    const merged = [...new Set([...saved, ...(newest.idsAtDate ?? [newest.reviewId])])];
    if (merged.length === saved.length) return null;
    return { reviewId: newest.reviewId, date: newest.date, idsAtDate: merged };
}
