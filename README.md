# App Store Reviews & Metadata

Scrape customer reviews and app metadata from the Apple App Store. Give the Actor a list of apps and countries. It returns one clean dataset with app details and reviews.

The Actor reads Apple's public RSS and lookup endpoints. It needs no login, no proxy and no browser. A run is fast and cheap.

## What you get

- Reviews: title, text, star rating, app version, author, date, helpful votes.
- App metadata: name, developer, bundle id, price, average rating, rating count, version, release notes, genres, store URL.
- Many apps and many countries in one run.
- Incremental mode: get only reviews that are new since the last run.

## Input

| Field | Type | Default | Description |
|---|---|---|---|
| `apps` | array of strings | required | Numeric ids (`389801252`), ids with prefix (`id389801252`) or App Store URLs. |
| `countries` | array of strings | `["us"]` | Two-letter App Store country codes. |
| `maxReviewsPerApp` | integer | `100` | Reviews for each app and country. Maximum `500`. Use `0` for metadata only. |
| `includeMetadata` | boolean | `false` | Add one `app` row for each app and country. Shown in the **Apps** output view. Each review row always has `appName`. |
| `onlyNewReviews` | boolean | `false` | Emit only reviews newer than the last run. State is kept in the named key-value store `appstore-reviews-state`. |
| `stateKey` | string | empty | Keeps the saved state of one task apart from other tasks that track the same app. Use a different value for each task. |
| `sinceDate` | string | none | ISO date. Older reviews are skipped. |

Example:

```json
{
  "apps": [
    "https://apps.apple.com/us/app/duolingo-language-lessons/id570060128",
    "389801252"
  ],
  "countries": ["us", "gb"],
  "maxReviewsPerApp": 100,
  "includeMetadata": true,
  "onlyNewReviews": false
}
```

## Output

The dataset has two item types. Use the `type` field to tell them apart.

Review item:

```json
{
  "type": "review",
  "appId": "570060128",
  "appName": "Duolingo: Language Lessons",
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

(Values in the examples are for illustration.)

## Pricing

This Actor uses pay-per-event pricing. You pay only for the data you get.

| Event | Charged when |
|---|---|
| `app-metadata` | The Actor saves one app item. |
| `review` | The Actor saves one review item. Charged in batches of up to 50. |

The Actor respects your maximum charge per run. When the limit is reached, the Actor stops and keeps the data it already saved.

## Limits

- Apple's feed gives about 500 reviews at most for each app and country (10 pages of 50). Older reviews are not available from this source.
- Reviews are sorted newest first.
- Some apps have no reviews in some countries. The Actor returns the app item and no review items.
- Apple's feed can lag by some hours and sometimes drops reviews. Counts can differ a little from the App Store page.
- Only text reviews with a star rating are in the feed. Ratings without text are not.
- In `onlyNewReviews` mode, the Actor saves the newest review per app and country, but only when it pushed every new review. If `maxReviewsPerApp`, a failed page, or the max charge stops the run early, the saved state stays the same. The next run can then emit some of the same reviews again, but it never skips a review. For a busy app, set `maxReviewsPerApp` high enough for the reviews that arrive between runs.
- Tasks that track the same app share one saved state. Set a different `stateKey` in each task.

## Reliability

- The Actor retries 429, 5xx and network errors 3 times with exponential backoff.
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
