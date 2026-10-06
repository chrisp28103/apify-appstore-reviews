# Apple App Store Reviews Scraper

Scrape customer reviews and app metadata from the Apple App Store. Give the Actor a list of apps and countries. It returns one clean dataset with reviews. Each review row has the app details.

The Actor reads Apple's public RSS and lookup endpoints. It needs no login and no browser. It needs no proxy in most cases. A run is fast and cheap.

## What you get

- Reviews: title, text, star rating, app version, author, date, helpful votes.
- App fields on every review row: name, developer, bundle id, average rating, rating count, store link.
- App metadata rows (metadata-only runs): price, version, release notes, genres, and more.
- Star filter and keyword filter. Filtered-out reviews are not charged.
- Sort by most recent or most helpful.
- Many apps and many countries in one run. You can give a bundle id in place of a numeric id.
- Incremental mode: get only reviews that are new since the last run.

## Input

| Field | Type | Default | Description |
|---|---|---|---|
| `apps` | array of strings | required | Numeric ids (`389801252`), ids with prefix (`id389801252`), App Store URLs or bundle ids (`com.duolingo.DuolingoMobile`). The Actor finds the numeric id of a bundle id with the first country. |
| `countries` | array of strings | `["us"]` | Two-letter App Store country codes. |
| `maxReviewsPerApp` | integer | `100` | Reviews for each app and country. Maximum `500`. Use `0` for metadata only. |
| `includeMetadata` | boolean | `false` | Every review row always has the app fields. Turn this on with `maxReviewsPerApp` set to `0` to get one `app` row for each app and country (metadata-only run). Shown in the **Apps** output view. With reviews on, the Actor logs a note and emits no `app` rows. |
| `onlyNewReviews` | boolean | `false` | Emit only reviews newer than the last run. State is kept in the named key-value store `appstore-reviews-state`. |
| `stateKey` | string | empty | Keeps the saved state of one task apart from other tasks that track the same app. Use a different value for each task. |
| `sinceDate` | string | none | ISO date. Older reviews are skipped. |
| `sort` | string | `mostrecent` | `mostrecent` or `mosthelpful`. `onlyNewReviews` needs `mostrecent`. With `mosthelpful`, the Actor ignores `onlyNewReviews` and logs a warning. |
| `minRating` | integer | none | Keep only reviews with this many stars or more (1 to 5). |
| `maxRating` | integer | none | Keep only reviews with this many stars or less (1 to 5). `minRating` must not be higher than `maxRating`. |
| `keywords` | array of strings | none | Keep only reviews whose title or text has any of these words. Case does not matter. |
| `proxyConfiguration` | object | no proxy | Proxy settings. Use them if Apple answers with HTTP 403. |

The star and keyword filters run before the charge. The Actor never charges a review that a filter removes. A removed review does not count toward `maxReviewsPerApp`. The Actor reads more pages (up to 10) to find enough matching reviews.

Example:

```json
{
  "apps": [
    "https://apps.apple.com/us/app/duolingo-language-lessons/id570060128",
    "389801252"
  ],
  "countries": ["us", "gb"],
  "maxReviewsPerApp": 100,
  "includeMetadata": false,
  "onlyNewReviews": false,
  "sort": "mostrecent",
  "minRating": 1,
  "maxRating": 3,
  "keywords": ["crash", "login"],
  "proxyConfiguration": { "useApifyProxy": false }
}
```

## Output

The dataset has two item types. Use the `type` field to tell them apart. A normal run has review items only. App items appear only in metadata-only runs.

Review item:

```json
{
  "type": "review",
  "appId": "570060128",
  "appName": "Duolingo - Language Lessons",
  "appDeveloper": "Duolingo",
  "appBundleId": "com.duolingo.DuolingoMobile",
  "appAverageRating": 4.7,
  "appRatingCount": 1000000,
  "appUrl": "https://apps.apple.com/us/app/duolingo-language-lessons/id570060128",
  "sort": "mostrecent",
  "country": "us",
  "reviewId": "14629312959",
  "title": "Great for daily practice",
  "text": "I use it every day and my streak is 200 days.",
  "rating": 5,
  "version": "8.12.0",
  "author": "SampleUser",
  "authorUrl": "https://itunes.apple.com/us/reviews/id123456789",
  "date": "2026-10-05T14:21:07.000Z",
  "voteSum": 0,
  "voteCount": 0,
  "scrapedAt": "2026-10-06T09:00:00.000Z"
}
```

App item:

```json
{
  "type": "app",
  "appId": "570060128",
  "country": "us",
  "name": "Duolingo - Language Lessons",
  "developer": "Duolingo",
  "bundleId": "com.duolingo.DuolingoMobile",
  "price": 0,
  "currency": "USD",
  "averageRating": 4.7,
  "ratingCount": 1000000,
  "version": "8.12.0",
  "releaseNotes": "Bug fixes and improvements.",
  "genres": ["Education", "Games"],
  "url": "https://apps.apple.com/us/app/duolingo-language-lessons/id570060128",
  "scrapedAt": "2026-10-06T09:00:00.000Z"
}
```

The `app*` fields are `null` when Apple has no lookup record for the store.

(Values in the examples are for illustration.)

## Pricing

This Actor uses pay-per-event pricing. You pay only for the data you get.

| Event | Charged when |
|---|---|
| `app-metadata` | The Actor saves one app item (metadata-only run). |
| `review` | The Actor saves one review item. |

The Actor respects your maximum charge per run. When the limit is reached, the Actor stops and keeps the data it already saved.

## Limits

- Apple's feed gives about 500 reviews at most for each app and country (10 pages of 50). Older reviews are not available from this source.
- Reviews are sorted newest first, unless you set `sort` to `mosthelpful`.
- Developer replies: Apple's public feed does not include them.
- Some apps have no reviews in some countries. The Actor returns no review items for them.
- Apple's feed can lag by some hours and sometimes drops reviews. Counts can differ a little from the App Store page.
- Only text reviews with a star rating are in the feed. Ratings without text are not.
- In `onlyNewReviews` mode, the Actor saves the newest review it saw for each app and country, but only when it pushed every new matching review. Reviews that a filter removes are skipped for good, so the saved state moves past them. If `maxReviewsPerApp`, a failed page, or the max charge stops the run early, the saved state stays the same. The next run can then emit some of the same reviews again, but it never skips a review. For a busy app, set `maxReviewsPerApp` high enough for the reviews that arrive between runs.
- Tasks that track the same app share one saved state. Set a different `stateKey` in each task.

## Reliability

- The Actor retries 403, 429, 5xx and network errors 3 times with exponential backoff.
- If Apple keeps answering 403, set `proxyConfiguration`. The Actor then sends all requests through the proxy.
- Each request has a 20 second timeout.
- The Actor runs 3 requests at the same time to stay polite.
- One failing app or country does not stop the run. The Actor logs the error and continues.
- Review ids are de-duplicated for each app and country.

## FAQ

**Do I need an Apple account or API key?**
No. The Actor uses public endpoints.

**How do I find an app id?**
Open the app page on the App Store. The URL ends with `id` and a number, for example `id570060128`. You can paste the full URL.

**How do I get only new reviews each day?**
Set `onlyNewReviews` to `true` and schedule the Actor daily. The first run returns the latest reviews. Later runs return only newer ones.

**Can I get more than 500 reviews?**
No. Apple's feed limits each app and country to about 500. Run the Actor on a schedule with `onlyNewReviews` to build a longer history over time. Run it often enough that fewer than `maxReviewsPerApp` new reviews arrive between runs.

**Does it scrape Google Play?**
No. This Actor is for the Apple App Store only.

## Development

```bash
npm install
npm run build
npm test            # unit tests, no network
LIVE=1 npm run test:live   # opt-in test against the real Apple endpoints
npm run lint
```

Run locally with the Apify CLI:

```bash
npx apify-cli run --purge
```

## License

MIT, Chris Perry.
