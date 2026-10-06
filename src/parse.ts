import type { ActorInput, ResolvedInput, SortOrder } from './types.js';

export const MAX_REVIEWS_LIMIT = 500;
export const DEFAULT_MAX_REVIEWS = 100;

/** Extract a numeric App Store id from "123", "id123" or an App Store URL. Returns null if none. */
export function parseAppId(raw: unknown): string | null {
    if (typeof raw !== 'string' && typeof raw !== 'number') return null;
    const value = String(raw).trim();
    if (/^\d+$/.test(value)) return value;
    if (/^id\d+$/i.test(value)) return value.slice(2);
    const match = value.match(/\/id(\d+)(?:[/?#]|$)/i) ?? value.match(/[?&]id=(\d+)/i);
    return match ? match[1] : null;
}

/** Return the entry when it looks like a reverse-DNS bundle id, such as com.duolingo.DuolingoMobile. Else null. */
export function parseBundleId(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const value = raw.trim();
    return /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(value) ? value : null;
}

/** Charged app rows are for metadata-only runs. With reviews on, the app fields are on each review row. */
export function shouldEmitAppRows(includeMetadata: boolean, maxReviewsPerApp: number): boolean {
    return includeMetadata && maxReviewsPerApp === 0;
}

function parseStars(value: unknown, name: string): number | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 5) {
        throw new Error(`Input "${name}" must be a whole number from 1 to 5.`);
    }
    return value;
}

/** Validate a 2-letter country code. Returns the lower-case code or null. */
export function parseCountry(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const value = raw.trim().toLowerCase();
    return /^[a-z]{2}$/.test(value) ? value : null;
}

/** Turn the raw Actor input into a validated, de-duplicated config. Throws on unusable input. */
export function resolveInput(input: ActorInput | null | undefined): ResolvedInput {
    const warnings: string[] = [];
    const raw = input ?? {};

    const appIds: string[] = [];
    const bundleIds: string[] = [];
    for (const entry of raw.apps ?? []) {
        const id = parseAppId(entry);
        const bundleId = id ? null : parseBundleId(entry);
        if (id) {
            if (!appIds.includes(id)) appIds.push(id);
        } else if (bundleId) {
            if (!bundleIds.includes(bundleId)) bundleIds.push(bundleId);
        } else {
            warnings.push(`Skipped app "${String(entry)}": could not find a numeric app id or a bundle id.`);
        }
    }
    if (appIds.length === 0 && bundleIds.length === 0) {
        throw new Error('Input "apps" has no valid app. Use numeric ids, "id123", App Store URLs or bundle ids.');
    }

    const countries: string[] = [];
    for (const entry of raw.countries && raw.countries.length > 0 ? raw.countries : ['us']) {
        let code = parseCountry(entry);
        if (code === 'uk') {
            warnings.push('Country "uk" changed to "gb", the App Store code for the United Kingdom.');
            code = 'gb';
        }
        if (!code) {
            warnings.push(`Skipped country "${String(entry)}": use a 2-letter code such as "us".`);
        } else if (!countries.includes(code)) {
            countries.push(code);
        }
    }
    if (countries.length === 0) {
        throw new Error('Input "countries" has no valid 2-letter country code.');
    }

    let maxReviewsPerApp = raw.maxReviewsPerApp ?? DEFAULT_MAX_REVIEWS;
    if (!Number.isFinite(maxReviewsPerApp) || maxReviewsPerApp < 0) {
        throw new Error('Input "maxReviewsPerApp" must be a number from 0 to 500.');
    }
    maxReviewsPerApp = Math.floor(maxReviewsPerApp);
    if (maxReviewsPerApp > MAX_REVIEWS_LIMIT) {
        warnings.push(`maxReviewsPerApp lowered from ${maxReviewsPerApp} to ${MAX_REVIEWS_LIMIT}, the Apple feed limit.`);
        maxReviewsPerApp = MAX_REVIEWS_LIMIT;
    }

    let sinceDate: Date | null = null;
    if (raw.sinceDate) {
        sinceDate = new Date(raw.sinceDate);
        if (Number.isNaN(sinceDate.getTime())) {
            throw new Error(`Input "sinceDate" is not a valid ISO date: ${raw.sinceDate}`);
        }
    }

    const minRating = parseStars(raw.minRating, 'minRating');
    const maxRating = parseStars(raw.maxRating, 'maxRating');
    if (minRating !== null && maxRating !== null && minRating > maxRating) {
        throw new Error(`Input "minRating" (${minRating}) is higher than "maxRating" (${maxRating}).`);
    }

    const keywords = (raw.keywords ?? [])
        .filter((k): k is string => typeof k === 'string')
        .map((k) => k.trim().toLowerCase())
        .filter((k) => k.length > 0);

    const sort: SortOrder = raw.sort ?? 'mostrecent';
    if (sort !== 'mostrecent' && sort !== 'mosthelpful') {
        throw new Error('Input "sort" must be "mostrecent" or "mosthelpful".');
    }
    let onlyNewReviews = raw.onlyNewReviews ?? false;
    if (onlyNewReviews && sort !== 'mostrecent') {
        warnings.push('onlyNewReviews needs sort "mostrecent". The Actor ignores onlyNewReviews for this run.');
        onlyNewReviews = false;
    }

    return {
        appIds,
        bundleIds,
        countries,
        maxReviewsPerApp,
        includeMetadata: raw.includeMetadata ?? false,
        onlyNewReviews,
        sinceDate,
        stateKey: typeof raw.stateKey === 'string' ? raw.stateKey.trim().replace(/[^A-Za-z0-9!_.*'()-]/g, '-') : '',
        sort,
        minRating,
        maxRating,
        keywords: [...new Set(keywords)],
        proxyConfiguration: raw.proxyConfiguration && typeof raw.proxyConfiguration === 'object' ? raw.proxyConfiguration : null,
        warnings,
    };
}

export function toArray<T>(value: T | T[] | undefined | null): T[] {
    if (value === undefined || value === null) return [];
    return Array.isArray(value) ? value : [value];
}
