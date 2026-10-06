import { Actor, log } from 'apify';
import { createProxyFetch, mapLimit, type FetchOptions } from './fetch.js';
import { addAppFields } from './normalise.js';
import { resolveInput, shouldEmitAppRows } from './parse.js';
import { fetchAppMetadata, fetchReviewsResult, nextState, resolveBundleId } from './scrape.js';
import type { ActorInput, AppState } from './types.js';

const CONCURRENCY = 3;

interface ChargeOutcome {
    chargedCount: number;
    eventChargeLimitReached: boolean;
}
const BATCH_SIZE = 50;

await Actor.init();

try {
    const input = resolveInput(await Actor.getInput<ActorInput>());
    for (const w of input.warnings) log.warning(w);

    let fetchOptions: FetchOptions | undefined;
    if (input.proxyConfiguration) {
        const proxy = await Actor.createProxyConfiguration(input.proxyConfiguration);
        if (proxy) {
            fetchOptions = { fetchImpl: createProxyFetch(() => proxy.newUrl()) };
            log.info('Fetching through the proxy.');
        }
    }

    const appIds = [...input.appIds];
    for (const bundleId of input.bundleIds) {
        try {
            const id = await resolveBundleId(bundleId, input.countries[0], fetchOptions);
            if (!id) log.warning(`Skipped bundle id "${bundleId}": not found in store "${input.countries[0]}".`);
            else if (!appIds.includes(id)) appIds.push(id);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warning(`Skipped bundle id "${bundleId}": lookup failed (${msg}).`);
        }
    }
    if (appIds.length === 0) throw new Error('No app to scrape. No bundle id could be resolved.');

    const emitAppRows = shouldEmitAppRows(input.includeMetadata, input.maxReviewsPerApp);
    if (input.includeMetadata && !emitAppRows) {
        log.info('App fields are on each review row (appName, appDeveloper, and more). The Actor emits no separate app rows.');
    }

    const state = input.onlyNewReviews ? await Actor.openKeyValueStore('appstore-reviews-state') : null;
    let limitReached = false;

    // Without pay-per-event pricing (local runs, free runs) Actor.charge does nothing and reports 0 charged.
    // Treat that case as "no limit" so the run still produces data.
    const isPpe = Actor.getChargingManager().getPricingInfo().isPayPerEvent;
    const charge = async (eventName: string, count = 1): Promise<ChargeOutcome> =>
        isPpe
            ? Actor.charge({ eventName, count })
            : { chargedCount: count, eventChargeLimitReached: false };
    const counts = { apps: 0, reviews: 0, failed: 0 };

    const jobs = appIds.flatMap((appId) => input.countries.map((country) => ({ appId, country })));
    log.info(`Scraping ${jobs.length} app and country pairs.`);

    const results = await mapLimit(jobs, CONCURRENCY, async ({ appId, country }) => {
        const tag = `${appId}/${country}`;
        if (limitReached) return;

        // Always look up the app (free, no charge) so each review row carries the app name.
        let app = null;
        try {
            app = await fetchAppMetadata(appId, country, fetchOptions);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warning(`${tag}: metadata failed (${msg}). Continuing with reviews.`);
        }

        if (emitAppRows) {
            if (app) {
                const charged = await charge('app-metadata');
                if (charged.chargedCount < 1) {
                    limitReached = true;
                    log.warning('Max charge reached. Stopping.');
                    return;
                }
                await Actor.pushData(app);
                counts.apps++;
            } else {
                log.warning(`${tag}: no app metadata for this store.`);
            }
        }

        if (input.maxReviewsPerApp === 0 || limitReached) return;

        const stateKey = `${input.stateKey ? `${input.stateKey}-` : ''}${appId}-${country}`;
        const previous = state ? await state.getValue<AppState>(stateKey) : null;
        const { reviews, complete, newestSeen } = await fetchReviewsResult({
            appId,
            country,
            maxReviews: input.maxReviewsPerApp,
            sinceDate: input.sinceDate,
            state: previous,
            sort: input.sort,
            minRating: input.minRating,
            maxRating: input.maxRating,
            keywords: input.keywords,
            fetchOptions,
        });
        for (const r of reviews) addAppFields(r, app, input.sort);

        const pushed = [];
        for (let i = 0; i < reviews.length && !limitReached; i += BATCH_SIZE) {
            const batch = reviews.slice(i, i + BATCH_SIZE);
            const charged = await charge('review', batch.length);
            const allowed = batch.slice(0, charged.chargedCount);
            if (allowed.length > 0) {
                await Actor.pushData(allowed);
                pushed.push(...allowed);
                counts.reviews += allowed.length;
            }
            if (charged.eventChargeLimitReached || allowed.length < batch.length) {
                limitReached = true;
                log.warning('Max charge reached. Stopping.');
            }
        }

        // Move the saved state only when every new review was pushed. Else the unpushed older reviews are lost for good.
        const allPushed = complete && pushed.length === reviews.length;
        // Filtered-out new reviews are skipped on purpose, so the state moves to the newest review SEEN.
        const next = state && allPushed ? nextState(previous, newestSeen) : null;
        if (state && next) {
            await state.setValue(stateKey, next);
        } else if (state && pushed.length > 0 && !allPushed) {
            log.warning(`${tag}: run stopped early. Saved state not moved, so the next run can emit the same reviews again. Raise maxReviewsPerApp or the max charge.`);
        }
        log.info(`${tag}: ${pushed.length} reviews.`);
    });

    results.forEach((r, i) => {
        if (r.status === 'rejected') {
            counts.failed++;
            const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
            log.error(`${jobs[i].appId}/${jobs[i].country} failed: ${msg}`);
        }
    });

    log.info(`Done. ${counts.apps} app items, ${counts.reviews} review items, ${counts.failed} failed pairs.`);
    await Actor.setStatusMessage(`${counts.apps} apps, ${counts.reviews} reviews, ${counts.failed} failed`);
    if (counts.failed === jobs.length) throw new Error('Every app and country pair failed.');
} catch (err) {
    log.exception(err as Error, 'Run failed');
    await Actor.exit({ exitCode: 1 });
}

await Actor.exit();
