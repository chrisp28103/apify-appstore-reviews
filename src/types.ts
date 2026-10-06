export interface ActorInput {
    apps?: string[];
    countries?: string[];
    maxReviewsPerApp?: number;
    includeMetadata?: boolean;
    onlyNewReviews?: boolean;
    sinceDate?: string;
    stateKey?: string;
    sort?: SortOrder;
    minRating?: number;
    maxRating?: number;
    keywords?: string[];
    proxyConfiguration?: Record<string, unknown>;
}

export type SortOrder = 'mostrecent' | 'mosthelpful';

export interface ResolvedInput {
    appIds: string[];
    /** Reverse-DNS bundle ids that main must resolve to numeric app ids. */
    bundleIds: string[];
    countries: string[];
    maxReviewsPerApp: number;
    includeMetadata: boolean;
    onlyNewReviews: boolean;
    sinceDate: Date | null;
    stateKey: string;
    sort: SortOrder;
    minRating: number | null;
    maxRating: number | null;
    /** Lower-case keywords. A review matches when its title or text has any of them. */
    keywords: string[];
    proxyConfiguration: Record<string, unknown> | null;
    warnings: string[];
}

export interface ReviewItem {
    type: 'review';
    appId: string;
    /** App name from the lookup API. Null when Apple has no lookup record for this store. */
    appName?: string | null;
    appDeveloper?: string | null;
    appBundleId?: string | null;
    appAverageRating?: number | null;
    appRatingCount?: number | null;
    appUrl?: string | null;
    /** Sort order of the run that produced this row. */
    sort?: SortOrder;
    country: string;
    reviewId: string;
    title: string;
    text: string;
    rating: number;
    version: string;
    author: string;
    authorUrl: string | null;
    date: string;
    voteSum: number;
    voteCount: number;
    scrapedAt: string;
}

export interface AppItem {
    type: 'app';
    appId: string;
    country: string;
    name: string;
    developer: string;
    bundleId: string;
    price: number | null;
    currency: string | null;
    averageRating: number | null;
    ratingCount: number | null;
    version: string;
    releaseNotes: string | null;
    genres: string[];
    url: string;
    scrapedAt: string;
}

export interface AppState {
    reviewId: string;
    date: string;
    /** Every review id that shares the newest date. Missing in state from older versions. */
    idsAtDate?: string[];
}
