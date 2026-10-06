/* eslint-disable @typescript-eslint/no-explicit-any */
import { toArray } from './parse.js';
import type { AppItem, ReviewItem, SortOrder } from './types.js';

type Label = { label?: string } | undefined;
const label = (node: Label): string => (node && typeof node.label === 'string' ? node.label : '');

/**
 * Convert the Apple RSS JSON feed to review items.
 * Handles: missing feed, missing entry, a single entry object, and the app-info entry
 * (no im:rating) that can appear first on page 1.
 */
export function normaliseReviewsFeed(json: any, appId: string, country: string, scrapedAt: string): ReviewItem[] {
    const entries = toArray<any>(json?.feed?.entry);
    const reviews: ReviewItem[] = [];
    for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;
        const ratingText = label(entry['im:rating']);
        const reviewId = label(entry.id);
        if (!ratingText || !reviewId) continue; // app info entry or malformed
        const rating = Number(ratingText);
        if (!Number.isFinite(rating)) continue;
        const date = new Date(label(entry.updated));
        reviews.push({
            type: 'review',
            appId,
            country,
            reviewId,
            title: label(entry.title),
            text: label(entry.content),
            rating,
            version: label(entry['im:version']),
            author: label(entry.author?.name),
            authorUrl: label(entry.author?.uri) || null,
            date: Number.isNaN(date.getTime()) ? '' : date.toISOString(),
            voteSum: Number(label(entry['im:voteSum'])) || 0,
            voteCount: Number(label(entry['im:voteCount'])) || 0,
            scrapedAt,
        });
    }
    return reviews;
}

/** Convert an iTunes lookup response to an app item, or null if the app is not found. */
export function normaliseLookup(json: any, appId: string, country: string, scrapedAt: string): AppItem | null {
    const results = toArray<any>(json?.results);
    const result = results.find((r) => r && String(r.trackId) === appId);
    if (!result) return null;
    return {
        type: 'app',
        appId,
        country,
        name: result.trackName ?? '',
        developer: result.artistName ?? '',
        bundleId: result.bundleId ?? '',
        price: typeof result.price === 'number' ? result.price : null,
        currency: result.currency ?? null,
        averageRating: typeof result.averageUserRating === 'number' ? result.averageUserRating : null,
        ratingCount: typeof result.userRatingCount === 'number' ? result.userRatingCount : null,
        version: result.version ?? '',
        releaseNotes: result.releaseNotes ?? null,
        genres: Array.isArray(result.genres) ? result.genres : [],
        url: result.trackViewUrl ?? '',
        scrapedAt,
    };
}

/** Copy the app fields from the lookup onto a review row. Fields are null when the lookup found no app. */
export function addAppFields(review: ReviewItem, app: AppItem | null, sort: SortOrder): void {
    review.appName = app?.name ?? null;
    review.appDeveloper = app?.developer ?? null;
    review.appBundleId = app?.bundleId ?? null;
    review.appAverageRating = app?.averageRating ?? null;
    review.appRatingCount = app?.ratingCount ?? null;
    review.appUrl = app?.url ?? null;
    review.sort = sort;
}
