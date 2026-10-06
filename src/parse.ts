import type { ActorInput, ResolvedInput } from './types.js';

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
    for (const entry of raw.apps ?? []) {
        const id = parseAppId(entry);
        if (!id) {
            warnings.push(`Skipped app "${String(entry)}": could not find a numeric app id.`);
        } else if (!appIds.includes(id)) {
            appIds.push(id);
        }
    }
    if (appIds.length === 0) {
        throw new Error('Input "apps" has no valid app id. Use numeric ids, "id123" or App Store URLs.');
    }

    const countries: string[] = [];
    for (const entry of raw.countries && raw.countries.length > 0 ? raw.countries : ['us']) {
        const code = parseCountry(entry);
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

    return {
        appIds,
        countries,
        maxReviewsPerApp,
        includeMetadata: raw.includeMetadata ?? true,
        onlyNewReviews: raw.onlyNewReviews ?? false,
        sinceDate,
        warnings,
    };
}

export function toArray<T>(value: T | T[] | undefined | null): T[] {
    if (value === undefined || value === null) return [];
    return Array.isArray(value) ? value : [value];
}
