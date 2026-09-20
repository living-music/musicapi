# musicapi

`musicapi` mirrors public metadata and media URLs exposed by the Church of Jesus Christ of Latter-day Saints music library. It also produces a smaller, stable catalog for static clients such as Living Music.

This is an independent project. It is not an official Church API and is not affiliated with or endorsed by The Church of Jesus Christ of Latter-day Saints.

## Published API

GitHub Pages publishes only the optimized catalog. Raw source responses remain in the repository for validation and rebuilding, but they are not part of the public Pages artifact.

| Path | Purpose |
| --- | --- |
| `/index.json` | Small discovery document pointing to the current API version |
| `/v1/index.json` | Collections, counts, revisions, and search metadata |
| `/v1/search.json` | Lightweight global song-search records |
| `/v1/collections/<collection>.json` | Normalized English songs and recordings for existing clients |
| `/v2/index.json` | Multilingual language discovery and per-language counts |
| `/v2/languages/<language>/index.json` | Localized collections and search metadata for one language |
| `/v2/languages/<language>/search.json` | Search records limited to songs available in that language |
| `/v2/languages/<language>/collections/<collection>.json` | Localized songs and recordings for one collection |

Apps may start with `/index.json` to discover the current version or request `/v1/index.json` directly when pinned to version 1. Relative `href` values include a deterministic revision query, allowing normal browser caching while fetching new content immediately after the index changes.

Fetch the search index only when global search is used, and fetch a collection only when it is opened. The catalog schema has an integer `schemaVersion`; consumers must reject unsupported versions rather than guessing.

```js
const apiRoot = new URL("https://living-music.github.io/musicapi/");
const manifest = await fetch(new URL("index.json", apiRoot)).then((response) => response.json());
const indexUrl = new URL(manifest.href, apiRoot);
const index = await fetch(indexUrl).then((response) => response.json());

// Resolve these against indexUrl because they are relative to the version directory.
const searchUrl = new URL(index.search.href, indexUrl);
const firstCollectionUrl = new URL(index.collections[0].href, indexUrl);
```

Cache search and collection responses using their `revision` values. A changed revision produces a changed query string in `href`, while unchanged content keeps the same URL.

### Multilingual catalog

Version 2 keeps each language in a separate lazy-loadable index. The root discovery document continues to point existing clients to v1 and includes a `multilingual` link for clients that understand schema version 2. A client can load `/v2/index.json`, present its `languages` list, then resolve the selected language's relative `href` to obtain localized albums, songs, and search data.

```js
const discovery = await fetch(new URL("index.json", apiRoot)).then((response) => response.json());
const multilingualUrl = new URL(discovery.multilingual.href, apiRoot);
const multilingual = await fetch(multilingualUrl).then((response) => response.json());
const spanish = multilingual.languages.find((language) => language.code === "spa");
const spanishIndex = await fetch(new URL(spanish.href, multilingualUrl)).then((response) => response.json());
```

The initial language set is English (`eng`, locale `en`) and Spanish (`spa`, locale `es`). Language codes follow the upstream Church catalog; `locale` supplies the corresponding web-platform locale.

English is the complete baseline catalog: it keeps every song and the same playback selection used by v1, including instrumental material and entries that currently lack a playable recording. For every additional language, a song is included only when the upstream response contains an `AUDIO_VOCAL*` or `VIDEO` recording explicitly tagged with that language. Accompaniment and instrumental recordings never establish translated-language availability by themselves. Once a translated song qualifies, v2 exposes only playback recordings explicitly tagged with the selected language. This prevents an untranslated song from appearing merely because the upstream response reused an English backing track.

Collection and song objects include `language` and `availableLanguages`. Stable song IDs remain `<collection-slug>:<song-slug>` across languages, allowing a client to preserve a library entry while changing its localized presentation. V2 recording IDs include the recording language to prevent translated media from colliding in downloads or recording preferences.

Song IDs use `<collection-slug>:<song-slug>`. Store favorites by song ID. Recording IDs add the normalized recording type. A song contains its default artwork; a recording contains `artworkUrl` only when that version has meaningfully different source artwork. Media remains hosted by the Church; this repository stores URLs and metadata, not audio files.

## Commands

Node.js 24 LTS or newer is required. There are no package dependencies.

```sh
npm test
npm run validate
npm run build
npm run refresh
```

- `test` checks page-data parsing, fallback selection, playable asset filtering, and URL deduplication.
- `validate` checks that every advertised collection exists, totals match, song IDs are unique, playback URLs are HTTPS, and the compact catalog agrees with the raw mirror.
- `build` regenerates the compact catalog from the checked-in raw mirror without network access.
- `refresh` downloads a complete snapshot into a temporary directory, validates it, builds the compact catalog, and only then replaces `sacredmusic/`.

Run `npm run validate` after any data or importer change. Do not hand-edit generated files under `sacredmusic/`; fix the transformation and rebuild instead.

## Automation

The `Refresh and publish catalog` workflow runs daily and can be started manually. Scheduled and manual runs refresh, rebuild, validate, commit changed data, and deploy that exact snapshot. Pushes to `main` rebuild and validate without contacting the upstream service; deployment stops if the committed compact catalog is stale.

The workflow uploads only `sacredmusic/catalog/`. In repository settings, GitHub Pages must use **GitHub Actions** as its source.

## Consumer guidance

- Treat this repository as a cache that can occasionally be unavailable or stale.
- Prefer `AUDIO_VOCAL`, `AUDIO_INSTRUMENTAL`, or audience-specific vocal recordings for everyday listening. Do not assume the first recording is the best default; accompaniment is frequently first in the source data.
- Show a recording selector when multiple versions exist.
- Keep an official source link in the interface and handle removed songs or changed media URLs.
- Test browser playback, seeking, and cross-origin behavior against representative live URLs before release.
- Do not infer reuse rights from public availability. Review applicable source terms and asset-specific rights before publishing an app that uses this data or artwork.

## Maintenance notes

The upstream API occasionally advertises a collection total before every record is retrievable. A mismatched collection is retried with smaller pages. The importer uses a complete retry when one becomes available, or accepts the retrievable count only when repeated attempts return the same ordered song set. Conflicting responses remain a hard failure, and refreshes stay atomic, so uncertain or partial data cannot replace the published snapshot.

The importer intentionally limits concurrency and retries transient request failures. Catalog builds use the first song’s artwork when a collection thumbnail is missing or known to be unavailable, then retain the collection’s last known artwork URL as a final recovery source. Known unavailable URLs are matched exactly, so a corrected upstream URL takes precedence automatically. Collection pagination continues until the reported total is reached or a short terminal page proves the endpoint is exhausted, at which point the recovery checks above apply. When a collection record has no direct audio but indicates other media, the importer checks the song page and merges playable `AUDIO_*` or `VIDEO` assets from `window.renderData`. Direct audio retains priority, duplicate URLs are ignored, and PDFs are never exposed as recordings. Any unresolved incomplete or malformed collection fails the run, leaving the previously published snapshot untouched.

The raw mirror is retained as internal build input for debugging and provenance. English remains at `sacredmusic/main.json` and `sacredmusic/api/`; additional languages live at `sacredmusic/languages/<language>/`. The versioned catalog is the only supported application-facing shape. Breaking changes require a new version directory and a migration note in this README.
