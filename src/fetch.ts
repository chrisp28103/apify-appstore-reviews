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

export type SortBy = 'mostrecent' | 'mosthelpful';

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const reviewsUrl = (appId: string, country: string, page: number, sort: SortBy = 'mostrecent') =>
    `https://itunes.apple.com/${country}/rss/customerreviews/page=${page}/id=${appId}/sortby=${sort}/json`;

/** Same feed with the store passed as ?cc=. Apple sometimes serves an empty feed on one form and not the other. */
export const reviewsUrlAlt = (appId: string, country: string, page: number, sort: SortBy = 'mostrecent') =>
    `https://itunes.apple.com/rss/customerreviews/page=${page}/id=${appId}/sortby=${sort}/json?cc=${country}`;

export const lookupUrl = (appId: string, country: string) =>
    `https://itunes.apple.com/lookup?id=${appId}&country=${country}`;

export const bundleLookupUrl = (bundleId: string, country: string) =>
    `https://itunes.apple.com/lookup?bundleId=${encodeURIComponent(bundleId)}&country=${country}`;

/**
 * Build a fetch function that sends each request through a proxy.
 * newUrl gives a proxy URL for each request, so a rotating proxy can change the IP.
 */
export function createProxyFetch(newUrl: () => Promise<string | undefined>): typeof fetch {
    const agents = new Map<string, unknown>();
    return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const undici = await import('undici');
        const proxyUrl = await newUrl();
        if (!proxyUrl) return fetch(input, init);
        if (!agents.has(proxyUrl)) agents.set(proxyUrl, new undici.ProxyAgent(proxyUrl));
        const dispatcher = agents.get(proxyUrl) as import('undici').Dispatcher;
        return undici.fetch(input as Parameters<typeof undici.fetch>[0], { ...(init as object), dispatcher }) as unknown as Response;
    }) as typeof fetch;
}

/**
 * GET a URL and parse JSON. Retries on 403, 429, 5xx, timeouts and network errors with
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
            const retryable = !(err instanceof HttpError) || err.status === 429 || err.status === 403 || err.status >= 500;
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
