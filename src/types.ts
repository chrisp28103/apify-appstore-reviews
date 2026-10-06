export interface ActorInput {
    apps?: string[];
    countries?: string[];
    maxReviewsPerApp?: number;
    includeMetadata?: boolean;
    onlyNewReviews?: boolean;
    sinceDate?: string;
    stateKey?: string;
}

export interface ResolvedInput {
    appIds: string[];
    countries: string[];
    maxReviewsPerApp: number;
    includeMetadata: boolean;
    onlyNewReviews: boolean;
    sinceDate: Date | null;
    stateKey: string;
    warnings: string[];
}

export interface ReviewItem {
    type: 'review';
    appId: string;
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
}
