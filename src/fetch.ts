/* eslint-disable @typescript-eslint/no-explicit-any */
export class HttpError extends Error {
    constructor(public status: number, public url: string) {
        super(`HTTP ${status} for ${url}`);
    }
}

export interface FetchOptions {
    retries?: number; // total tries
    timeoutMs?: number;
    baseDelayMs?: number;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const reviewsUrl = (appId: string, country: string, page: number) =>
    `https://itunes.apple.com/${country}/rss/customerreviews/page=${page}/id=${appId}/sortby=mostrecent/json`;

export const lookupUrl = (appId: string, country: string) =>
    `https://itunes.apple.com/lookup?id=${appId}&country=${country}`;

/**
 * GET a URL and parse JSON. Retries on 429, 5xx, timeouts and network errors with
 * exponential backoff. Other 4xx statuses throw HttpError at once. An empty body returns null.
 */
export async function fetchJson(url: string, opts: FetchOptions = {}): Promise<any> {
    const { retries = 3, timeoutMs = 20_000, baseDelayMs = 1000, fetchImpl = fetch, sleep = defaultSleep } = opts;
    let lastError: unknown;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const res = await fetchImpl(url, {
                headers: { accept: 'application/json', 'user-agent': 'apify-appstore-reviews/1.0' },
                signal: AbortSignal.timeout(timeoutMs),
            });
            if (!res.ok) throw new HttpError(res.status, url);
            const text = await res.text();
            if (!text.trim()) return null;
            try {
                return JSON.parse(text);
            } catch {
                throw new Error(`Invalid JSON from ${url}`); // retryable glitch
            }
        } catch (err) {
            lastError = err;
            const retryable = !(err instanceof HttpError) || err.status === 429 || err.status >= 500;
            if (!retryable || attempt === retries) break;
            await sleep(baseDelayMs * 2 ** (attempt - 1));
        }
    }
    throw lastError;
}

/** Run async tasks with a fixed concurrency. Never rejects; each result is settled. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
    const results: PromiseSettledResult<R>[] = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            try {
                results[i] = { status: 'fulfilled', value: await fn(items[i]) };
            } catch (reason) {
                results[i] = { status: 'rejected', reason };
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}
