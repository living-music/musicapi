const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = __dirname;
const DATA_DIRECTORY = path.join(ROOT, "sacredmusic");
const LANGUAGE = "eng";
const PAGE_SIZE = 500;
const RECOVERY_PAGE_SIZE = 20;
const COLLECTION_ATTEMPTS = 3;
const CONCURRENCY = 4;
const AUDIO_PREFIX = "AUDIO_";
const VIDEO_ASSET_TYPE = "VIDEO";
const CATALOG_VERSION = "v1";
const MULTILINGUAL_CATALOG_VERSION = "v2";
const CATALOG_LANGUAGES = [
  { code: "eng", locale: "en", name: "English", autonym: "English", default: true },
  { code: "spa", locale: "es", name: "Spanish", autonym: "Español" },
];
const KNOWN_UNAVAILABLE_ARTWORK_URLS = new Set([
  "https://www.churchofjesuschrist.org/imgs/181d0dd13a62be0c574124df14525854e11c0950/full/400,/0/default",
]);
const ARTWORK_TYPE_PRIORITY = [
  "AUDIO_VOCAL",
  "AUDIO_VOCAL_YOUTH",
  "AUDIO_VOCAL_CHILDREN",
  "AUDIO_VOCAL_FAMILY",
  "AUDIO_VOCAL_CONGREGATION",
  "AUDIO_INSTRUMENTAL",
  "AUDIO_ACCOMPANIMENT",
  "AUDIO_ACCOMPANIMENT_GUITAR",
  VIDEO_ASSET_TYPE,
];

function fail(message) {
  throw new Error(message);
}

function contentRevision(value) {
  const digest = crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return `sha256:${digest}`;
}

function revisionToken(revision) {
  return revision.slice("sha256:".length, "sha256:".length + 12);
}

async function fetchWithRetry(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { "user-agent": "musicapi catalog mirror" } });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
      }
    }
  }
  throw new Error(`Request failed after ${attempts} attempts: ${url}\n${lastError}`);
}

function parseRenderData(html) {
  const marker = /window\.renderData\s*=\s*/.exec(html);
  if (!marker) fail("The music library page did not contain window.renderData");
  const sourceStart = marker.index + marker[0].length;
  const scriptEnd = html.indexOf("</script>", sourceStart);
  if (scriptEnd === -1) fail("Could not find the end of window.renderData");
  const source = html.slice(sourceStart, scriptEnd).trim().replace(/;$/, "");
  return JSON.parse(source);
}

function isDirectAudioAsset(asset) {
  return Boolean(asset?.assetType?.startsWith(AUDIO_PREFIX) && asset.distributionUrl?.startsWith("https://"));
}

function isPlaybackAsset(asset) {
  return Boolean(
    (asset?.assetType?.startsWith(AUDIO_PREFIX) || asset?.assetType === VIDEO_ASSET_TYPE)
    && asset.distributionUrl?.startsWith("https://"),
  );
}

function recordingAssets(assets) {
  const directAudio = (assets || []).filter(isDirectAudioAsset);
  return directAudio.length > 0
    ? directAudio
    : (assets || []).filter((asset) => asset?.assetType === VIDEO_ASSET_TYPE && isPlaybackAsset(asset));
}

function languageRecordingAssets(assets, language) {
  if (language === LANGUAGE) return recordingAssets(assets);
  const matching = (assets || []).filter((asset) => isPlaybackAsset(asset) && asset.lang === language);
  const vocalAudio = matching.filter((asset) => asset.assetType?.startsWith("AUDIO_VOCAL"));
  if (vocalAudio.length > 0) return matching.filter(isDirectAudioAsset);
  return matching.filter((asset) => asset.assetType === VIDEO_ASSET_TYPE);
}

function songAvailableInLanguage(song, language) {
  if (language === LANGUAGE) return true;
  return languageRecordingAssets(song.assets, language).length > 0;
}

function shouldFetchSongPage(song, language = LANGUAGE) {
  if (language === LANGUAGE && (song.assets || []).some(isDirectAudioAsset)) return false;
  if (language !== LANGUAGE && songAvailableInLanguage(song, language)) return false;
  return Boolean(song.videoAvailable || song.recordingAvailable || !song.sheetMusicAvailable);
}

function songPageUrl(slug, language = LANGUAGE) {
  const url = new URL(`https://www.churchofjesuschrist.org/media/music/songs/${encodeURIComponent(slug)}`);
  url.searchParams.set("lang", language);
  return url;
}

function songPageAssets(html, expectedSlug) {
  const renderData = parseRenderData(html);
  const data = renderData?.data;
  const song = data?.songData;
  if (data?.slugName !== expectedSlug || !song || typeof song !== "object" || Array.isArray(song)) {
    fail(`Song page ${expectedSlug} returned unexpected render data`);
  }
  if (Object.keys(song).length === 0 && data.sendToError === false) return [];
  if (song.slug !== expectedSlug || !Array.isArray(song.assets)) {
    fail(`Song page ${expectedSlug} returned unexpected song data`);
  }
  return song.assets.filter(isPlaybackAsset);
}

function mergePageAssets(song, pageAssets) {
  const assets = [...(song.assets || [])];
  const urls = new Set(assets.map((asset) => asset.distributionUrl).filter(Boolean));
  for (const asset of pageAssets) {
    if (!isPlaybackAsset(asset) || urls.has(asset.distributionUrl)) continue;
    assets.push(asset);
    urls.add(asset.distributionUrl);
  }
  return assets.length === (song.assets || []).length ? song : { ...song, assets };
}

async function fetchSongPageAssets(slug, language = LANGUAGE) {
  const response = await fetchWithRetry(songPageUrl(slug, language));
  return songPageAssets(await response.text(), slug);
}

function collectCollections(entry, collections = new Map()) {
  if (!entry || typeof entry !== "object") return collections;
  if (entry.$model === "musicLibraryItem") {
    if (!entry.slug || !entry.title) fail("A library item is missing its slug or title");
    if (!collections.has(entry.slug)) collections.set(entry.slug, entry);
    return collections;
  }
  for (const child of entry.entries || []) collectCollections(child, collections);
  return collections;
}

function songsUrl(slug, offset, limit = PAGE_SIZE, language = LANGUAGE) {
  const identifier = JSON.stringify({
    lang: language,
    limit,
    offset,
    orderByKey: ["bookSongPosition"],
    bookQueryList: [slug],
  });
  const url = new URL("https://www.churchofjesuschrist.org/media/music/api");
  url.searchParams.set("type", "songsFilteredList");
  url.searchParams.set("lang", language);
  url.searchParams.set("identifier", identifier);
  url.searchParams.set("batchSize", "20");
  return url;
}

async function fetchCollectionAttempt(slug, pageSize, language = LANGUAGE) {
  const songs = [];
  let total = Infinity;
  while (songs.length < total) {
    const response = await fetchWithRetry(songsUrl(slug, songs.length, pageSize, language));
    const page = await response.json();
    if (!Array.isArray(page.data) || !Number.isInteger(page.total)) {
      fail(`Collection ${slug} returned an unexpected response`);
    }
    total = page.total;
    if (page.data.length === 0) break;
    songs.push(...page.data);
    if (page.data.length < pageSize) break;
  }
  return { data: songs, reportedTotal: total };
}

function attemptSignature(attempt) {
  return attempt.data.map((song) => song?.slug || "").join("\n");
}

function reconcileCollectionAttempts(slug, attempts) {
  const complete = attempts
    .filter((attempt) => attempt.data.length === attempt.reportedTotal)
    .sort((left, right) => right.data.length - left.data.length)[0];
  if (complete) return { data: complete.data, total: complete.data.length };

  const consensus = new Map();
  for (const attempt of attempts) {
    const signature = attemptSignature(attempt);
    const matching = consensus.get(signature) || [];
    matching.push(attempt);
    consensus.set(signature, matching);
  }
  const stable = [...consensus.values()]
    .filter((matching) => matching.length >= 2)
    .sort((left, right) => right[0].data.length - left[0].data.length)[0];
  if (!stable) {
    const summary = attempts.map((attempt) => `${attempt.data.length}/${attempt.reportedTotal}`).join(", ");
    fail(`Collection ${slug} returned inconsistent incomplete results after ${attempts.length} attempts: ${summary}`);
  }
  return { data: stable.at(-1).data, total: stable.at(-1).data.length };
}

async function fetchCollection(slug, language = LANGUAGE) {
  const attempts = [await fetchCollectionAttempt(slug, PAGE_SIZE, language)];
  if (attempts[0].data.length === attempts[0].reportedTotal) {
    return { data: attempts[0].data, limit: PAGE_SIZE, offset: 0, total: attempts[0].reportedTotal };
  }
  while (attempts.length < COLLECTION_ATTEMPTS) {
    attempts.push(await fetchCollectionAttempt(slug, RECOVERY_PAGE_SIZE, language));
  }
  const resolved = reconcileCollectionAttempts(slug, attempts);
  const reportedTotals = [...new Set(attempts.map((attempt) => attempt.reportedTotal))].join("/");
  console.warn(
    `Warning: Collection ${slug} reports ${reportedTotals} songs but consistently exposes ${resolved.total}; `
    + `accepted after ${attempts.length} attempts.`,
  );
  return { data: resolved.data, limit: PAGE_SIZE, offset: 0, total: resolved.total };
}

async function mapConcurrent(values, limit, task) {
  const results = new Array(values.length);
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await task(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

function people(items) {
  return (items || []).map((item) => item.personName).filter(Boolean);
}

function imageUrl(asset) {
  const thumbnail = asset.thumbnail;
  if (!thumbnail) return null;
  const preferred = (thumbnail.renditions || []).find((item) => item.width === 500);
  return preferred?.distributionUrl || thumbnail.distributionUrl || null;
}

function recordingLabel(type) {
  const labels = {
    AUDIO_ACCOMPANIMENT: "Accompaniment",
    AUDIO_ACCOMPANIMENT_GUITAR: "Guitar accompaniment",
    AUDIO_INSTRUMENTAL: "Instrumental",
    AUDIO_VOCAL: "Vocal",
    AUDIO_VOCAL_CHILDREN: "Children's vocal",
    AUDIO_VOCAL_CONGREGATION: "Congregational vocal",
    AUDIO_VOCAL_FAMILY: "Family vocal",
    AUDIO_VOCAL_YOUTH: "Youth vocal",
    VIDEO: "Music video",
  };
  const fallback = type.startsWith(AUDIO_PREFIX) ? type.slice(AUDIO_PREFIX.length) : type;
  return labels[type] || fallback.toLowerCase().replaceAll("_", " ");
}

function normalizeSong(song, collectionSlug, options = {}) {
  const language = options.language || LANGUAGE;
  const schemaVersion = options.schemaVersion || 1;
  const songId = `${collectionSlug}:${song.slug}`;
  const typeCounts = new Map();
  const playbackAssets = options.playbackAssets || recordingAssets(song.assets);
  const artworkAsset = [...playbackAssets]
    .filter((asset) => imageUrl(asset))
    .sort((left, right) => {
      const leftIndex = ARTWORK_TYPE_PRIORITY.indexOf(left.assetType);
      const rightIndex = ARTWORK_TYPE_PRIORITY.indexOf(right.assetType);
      return (leftIndex === -1 ? Infinity : leftIndex) - (rightIndex === -1 ? Infinity : rightIndex);
    })[0];
  const artworkUrl = artworkAsset ? imageUrl(artworkAsset) : null;
  const recordings = playbackAssets.map((asset) => {
    const recordingLanguage = asset.lang || language;
    const countKey = schemaVersion === 1 ? asset.assetType : `${asset.assetType}:${recordingLanguage}`;
    const count = (typeCounts.get(countKey) || 0) + 1;
    typeCounts.set(countKey, count);
    const suffix = count === 1 ? "" : `:${count}`;
    const languageSuffix = schemaVersion === 1 ? "" : `:${recordingLanguage}`;
    const recordingArtworkUrl = imageUrl(asset);
    return {
      id: `${songId}:${asset.assetType.toLowerCase()}${languageSuffix}${suffix}`,
      type: asset.assetType,
      label: recordingLabel(asset.assetType),
      url: asset.distributionUrl,
      language: recordingLanguage,
      ...(asset.duration ? { durationMs: asset.duration } : {}),
      ...(recordingArtworkUrl && recordingArtworkUrl !== artworkUrl
        ? { artworkUrl: recordingArtworkUrl }
        : {}),
    };
  });
  return {
    id: songId,
    slug: song.slug,
    title: song.title,
    ...(schemaVersion === 2 ? {
      language,
      availableLanguages: options.availableLanguages || [language],
    } : {}),
    ...(song.subtitle ? { subtitle: song.subtitle } : {}),
    ...(song.songNumber ? { number: song.songNumber } : {}),
    ...(song.bookSectionTitle ? { section: song.bookSectionTitle } : {}),
    ...(song.songDate ? { date: song.songDate } : {}),
    ...(artworkUrl ? { artworkUrl } : {}),
    artists: people(song.artists),
    authors: people(song.authors),
    composers: people(song.composers),
    arrangers: people(song.arrangers),
    tags: song.tags || [],
    recordings,
  };
}

function collectionArtworkUrl(
  collection,
  fallbackArtwork = new Map(),
  firstSongArtworkUrl = null,
  unavailableArtworkUrls = KNOWN_UNAVAILABLE_ARTWORK_URLS,
) {
  const sourceArtworkUrl = collection.bookThumbnail?.renditions?.find((item) => item.distributionUrl)?.distributionUrl
    || collection.bookThumbnail?.distributionUrl;
  return (sourceArtworkUrl && !unavailableArtworkUrls.has(sourceArtworkUrl) ? sourceArtworkUrl : null)
    || firstSongArtworkUrl
    || fallbackArtwork.get(collection.slug)
    || null;
}

async function loadArtworkFallbacks(directory) {
  try {
    const data = JSON.parse(await fs.readFile(
      path.join(directory, "catalog", CATALOG_VERSION, "index.json"),
      "utf8",
    ));
    return new Map((data.collections || [])
      .filter((collection) => collection.id && collection.artworkUrl)
      .map((collection) => [collection.id, collection.artworkUrl]));
  } catch (error) {
    if (error.code === "ENOENT") return new Map();
    throw error;
  }
}

function collectionCore(collection) {
  return {
    id: collection.id,
    slug: collection.slug,
    title: collection.title,
    ...(collection.artworkUrl ? { artworkUrl: collection.artworkUrl } : {}),
    sourceUrl: collection.sourceUrl,
    songCount: collection.songCount,
    playableSongCount: collection.playableSongCount,
  };
}

function searchRecord(song, collectionId) {
  return {
    id: song.id,
    title: song.title,
    ...(song.number ? { number: song.number } : {}),
    collectionId,
    artists: song.artists,
    recordingTypes: [...new Set(song.recordings.map((recording) => recording.type))],
  };
}

function languageSourceDirectory(directory, language) {
  return language === LANGUAGE ? directory : path.join(directory, "languages", language);
}

function orderedLanguages(languages) {
  const order = new Map(CATALOG_LANGUAGES.map((language, index) => [language.code, index]));
  return [...languages].sort((left, right) => (order.get(left) ?? Infinity) - (order.get(right) ?? Infinity));
}

function searchRecordV2(song, collectionId) {
  return {
    ...searchRecord(song, collectionId),
    language: song.language,
    availableLanguages: song.availableLanguages,
  };
}

async function loadLanguageSources(directory) {
  const sources = [];
  for (const language of CATALOG_LANGUAGES) {
    const sourceDirectory = languageSourceDirectory(directory, language.code);
    let main;
    try {
      main = JSON.parse(await fs.readFile(path.join(sourceDirectory, "main.json"), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT" && !language.default) continue;
      throw error;
    }
    const collections = [...collectCollections(main?.data?.libraryData).values()];
    const localizedCollections = [];
    for (const collection of collections) {
      const raw = JSON.parse(await fs.readFile(path.join(sourceDirectory, "api", `${collection.slug}.json`), "utf8"));
      const songs = raw.data.filter((song) => songAvailableInLanguage(song, language.code));
      if (songs.length > 0) localizedCollections.push({ collection, songs });
    }
    sources.push({ language, collections: localizedCollections });
  }
  return sources;
}

async function buildMultilingualCatalog(directory, staging, artworkFallbacks) {
  const sources = await loadLanguageSources(directory);
  const versionDirectory = path.join(staging, MULTILINGUAL_CATALOG_VERSION);
  await fs.mkdir(versionDirectory, { recursive: true });

  const songLanguages = new Map();
  const collectionLanguages = new Map();
  for (const source of sources) {
    for (const { collection, songs } of source.collections) {
      const collectionSet = collectionLanguages.get(collection.slug) || new Set();
      collectionSet.add(source.language.code);
      collectionLanguages.set(collection.slug, collectionSet);
      for (const song of songs) {
        const id = `${collection.slug}:${song.slug}`;
        const languageSet = songLanguages.get(id) || new Set();
        languageSet.add(source.language.code);
        songLanguages.set(id, languageSet);
      }
    }
  }

  const languageEntries = [];
  for (const source of sources) {
    const languageDirectory = path.join(versionDirectory, "languages", source.language.code);
    const collectionDirectory = path.join(languageDirectory, "collections");
    await fs.mkdir(collectionDirectory, { recursive: true });
    const indexCollections = [];
    const searchRecords = [];

    for (const { collection, songs: rawSongs } of source.collections) {
      const songs = rawSongs.map((song) => normalizeSong(song, collection.slug, {
        schemaVersion: 2,
        language: source.language.code,
        availableLanguages: orderedLanguages(songLanguages.get(`${collection.slug}:${song.slug}`) || []),
        playbackAssets: languageRecordingAssets(song.assets, source.language.code),
      }));
      const sourceArtworkUrl = collectionArtworkUrl(collection, new Map(), songs[0]?.artworkUrl);
      const artworkUrl = sourceArtworkUrl || artworkFallbacks.get(collection.slug) || null;
      const core = {
        id: collection.slug,
        slug: collection.slug,
        title: collection.title,
        language: source.language.code,
        availableLanguages: orderedLanguages(collectionLanguages.get(collection.slug) || []),
        ...(artworkUrl ? { artworkUrl } : {}),
        sourceUrl: `https://www.churchofjesuschrist.org/media/music/collections/${collection.slug}?lang=${source.language.code}`,
        songCount: songs.length,
        playableSongCount: songs.filter((song) => song.recordings.length > 0).length,
      };
      const payloadCore = { schemaVersion: 2, language: source.language.code, collection: core, songs };
      const revision = contentRevision(payloadCore);
      const item = {
        ...core,
        revision,
        href: `collections/${collection.slug}.json?v=${revisionToken(revision)}`,
      };
      indexCollections.push(item);
      searchRecords.push(...songs.map((song) => searchRecordV2(song, collection.slug)));
      await fs.writeFile(
        path.join(collectionDirectory, `${collection.slug}.json`),
        `${JSON.stringify({ ...payloadCore, revision, collection: item })}\n`,
      );
    }

    const searchCore = { schemaVersion: 2, language: source.language.code, songs: searchRecords };
    const searchRevision = contentRevision(searchCore);
    await fs.writeFile(
      path.join(languageDirectory, "search.json"),
      `${JSON.stringify({ ...searchCore, revision: searchRevision })}\n`,
    );
    const playableSongCount = searchRecords.filter((song) => song.recordingTypes.length > 0).length;
    const stats = {
      collectionCount: indexCollections.length,
      songCount: searchRecords.length,
      playableSongCount,
    };
    const indexCore = {
      schemaVersion: 2,
      language: {
        code: source.language.code,
        locale: source.language.locale,
        name: source.language.name,
        autonym: source.language.autonym,
      },
      collections: indexCollections,
      stats,
      search: {
        revision: searchRevision,
        href: `search.json?v=${revisionToken(searchRevision)}`,
        songCount: searchRecords.length,
      },
    };
    const revision = contentRevision(indexCore);
    await fs.writeFile(
      path.join(languageDirectory, "index.json"),
      `${JSON.stringify({ ...indexCore, revision })}\n`,
    );
    languageEntries.push({
      code: source.language.code,
      locale: source.language.locale,
      name: source.language.name,
      autonym: source.language.autonym,
      revision,
      href: `languages/${source.language.code}/index.json?v=${revisionToken(revision)}`,
      stats,
    });
  }

  const indexCore = {
    schemaVersion: 2,
    defaultLanguage: LANGUAGE,
    languages: languageEntries,
  };
  const revision = contentRevision(indexCore);
  await fs.writeFile(
    path.join(versionDirectory, "index.json"),
    `${JSON.stringify({ ...indexCore, revision })}\n`,
  );
  return { revision, languages: languageEntries.length };
}

async function validateSnapshot(directory) {
  const main = JSON.parse(await fs.readFile(path.join(directory, "main.json"), "utf8"));
  const root = main?.data?.libraryData;
  if (!root) fail("main.json does not contain data.libraryData");
  const collections = [...collectCollections(root).values()];
  if (collections.length === 0) fail("main.json contains no music collections");

  const songIds = new Set();
  let songs = 0;
  let playableSongs = 0;
  let recordings = 0;
  for (const collection of collections) {
    const file = path.join(directory, "api", `${collection.slug}.json`);
    const payload = JSON.parse(await fs.readFile(file, "utf8"));
    if (!Array.isArray(payload.data) || payload.total !== payload.data.length) {
      fail(`${collection.slug}.json is incomplete or malformed`);
    }
    for (const song of payload.data) {
      if (!song.slug || !song.title) fail(`${collection.slug} contains a song without a slug or title`);
      const id = `${collection.slug}:${song.slug}`;
      if (songIds.has(id)) fail(`Duplicate song ID: ${id}`);
      songIds.add(id);
      songs += 1;
      const mediaAssets = (song.assets || []).filter((asset) =>
        asset?.assetType?.startsWith(AUDIO_PREFIX) || asset?.assetType === VIDEO_ASSET_TYPE);
      for (const asset of mediaAssets) {
        if (!asset.distributionUrl?.startsWith("https://")) fail(`${id} has an invalid playback URL`);
      }
      const playbackAssets = recordingAssets(mediaAssets);
      if (song.recordingAvailable && playbackAssets.length === 0) {
        fail(`${id} claims a recording but has no playable asset`);
      }
      if (playbackAssets.length > 0) playableSongs += 1;
      recordings += playbackAssets.length;
    }
  }
  return { collections: collections.length, songs, playableSongs, recordings };
}

async function validateMultilingualCatalog(catalogDirectory, manifest) {
  const versionDirectory = path.join(catalogDirectory, MULTILINGUAL_CATALOG_VERSION);
  const index = JSON.parse(await fs.readFile(path.join(versionDirectory, "index.json"), "utf8"));
  if (index.schemaVersion !== 2 || index.defaultLanguage !== LANGUAGE || !Array.isArray(index.languages)) {
    fail(`${MULTILINGUAL_CATALOG_VERSION}/index.json has an unsupported or malformed schema`);
  }
  const { revision, ...indexCore } = index;
  if (contentRevision(indexCore) !== revision) fail("Multilingual catalog revision does not match its content");
  if (
    manifest.multilingual?.schemaVersion !== 2
    || manifest.multilingual.revision !== revision
    || manifest.multilingual.href !== `${MULTILINGUAL_CATALOG_VERSION}/index.json?v=${revisionToken(revision)}`
    || manifest.multilingual.languageCount !== index.languages.length
  ) {
    fail("Catalog discovery document has invalid multilingual metadata");
  }

  const languageCodes = new Set();
  for (const languageEntry of index.languages) {
    if (languageCodes.has(languageEntry.code)) fail(`Duplicate catalog language: ${languageEntry.code}`);
    languageCodes.add(languageEntry.code);
    const expectedHref = `languages/${languageEntry.code}/index.json?v=${revisionToken(languageEntry.revision)}`;
    if (languageEntry.href !== expectedHref) fail(`Invalid multilingual language URL: ${languageEntry.code}`);
    const languageDirectory = path.join(versionDirectory, "languages", languageEntry.code);
    const languageIndex = JSON.parse(await fs.readFile(path.join(languageDirectory, "index.json"), "utf8"));
    const { revision: languageRevision, ...languageIndexCore } = languageIndex;
    if (
      languageIndex.schemaVersion !== 2
      || languageIndex.language?.code !== languageEntry.code
      || languageRevision !== languageEntry.revision
      || contentRevision(languageIndexCore) !== languageRevision
    ) {
      fail(`Invalid multilingual index for ${languageEntry.code}`);
    }

    const collectionIds = new Set();
    const songIds = new Set();
    const expectedSearchRecords = [];
    let recordings = 0;
    for (const collection of languageIndex.collections) {
      if (collectionIds.has(collection.id)) fail(`Duplicate ${languageEntry.code} collection: ${collection.id}`);
      collectionIds.add(collection.id);
      if (collection.language !== languageEntry.code || !collection.availableLanguages?.includes(languageEntry.code)) {
        fail(`Invalid language availability for collection ${collection.id}`);
      }
      const collectionHref = `collections/${collection.slug}.json?v=${revisionToken(collection.revision)}`;
      if (collection.href !== collectionHref) fail(`Invalid localized collection URL: ${collection.id}`);
      const payload = JSON.parse(await fs.readFile(
        path.join(languageDirectory, collection.href.split("?", 1)[0]),
        "utf8",
      ));
      if (
        payload.schemaVersion !== 2
        || payload.language !== languageEntry.code
        || payload.collection?.id !== collection.id
        || JSON.stringify(payload.collection) !== JSON.stringify(collection)
        || !Array.isArray(payload.songs)
      ) {
        fail(`Malformed localized collection: ${languageEntry.code}/${collection.id}`);
      }
      const { revision: payloadRevision, ...payloadWithoutRevision } = payload;
      const { revision: ignoredRevision, href: ignoredHref, ...payloadCollectionCore } = payloadWithoutRevision.collection;
      const payloadCore = {
        schemaVersion: payloadWithoutRevision.schemaVersion,
        language: payloadWithoutRevision.language,
        collection: payloadCollectionCore,
        songs: payloadWithoutRevision.songs,
      };
      if (contentRevision(payloadCore) !== payloadRevision || payloadRevision !== collection.revision) {
        fail(`Localized collection revision mismatch: ${languageEntry.code}/${collection.id}`);
      }
      const expectedPlayableSongCount = payload.songs.filter((song) => song.recordings?.length > 0).length;
      if (
        payload.songs.length !== collection.songCount
        || collection.playableSongCount !== expectedPlayableSongCount
      ) {
        fail(`Localized collection count mismatch: ${languageEntry.code}/${collection.id}`);
      }
      for (const song of payload.songs) {
        if (
          song.id !== `${collection.id}:${song.slug}`
          || songIds.has(song.id)
          || song.language !== languageEntry.code
          || !song.availableLanguages?.includes(languageEntry.code)
        ) {
          fail(`Invalid localized song: ${languageEntry.code}/${song.id}`);
        }
        songIds.add(song.id);
        if (
          languageEntry.code !== LANGUAGE
          && !song.recordings?.some((recording) =>
            recording.type?.startsWith("AUDIO_VOCAL") || recording.type === VIDEO_ASSET_TYPE)
        ) {
          fail(`Localized song has only background recordings: ${languageEntry.code}/${song.id}`);
        }
        for (const recording of song.recordings || []) {
          if (
            !recording.id?.startsWith(`${song.id}:`)
            || !recording.url?.startsWith("https://")
            || (languageEntry.code !== LANGUAGE && recording.language !== languageEntry.code)
          ) {
            fail(`Invalid localized recording: ${languageEntry.code}/${song.id}`);
          }
        }
        recordings += song.recordings.length;
        expectedSearchRecords.push(searchRecordV2(song, collection.id));
      }
    }

    const stats = {
      collectionCount: collectionIds.size,
      songCount: songIds.size,
      playableSongCount: expectedSearchRecords.filter((song) => song.recordingTypes.length > 0).length,
    };
    if (JSON.stringify(languageIndex.stats) !== JSON.stringify(stats) || JSON.stringify(languageEntry.stats) !== JSON.stringify(stats)) {
      fail(`Multilingual summary counts do not match for ${languageEntry.code}`);
    }
    const search = JSON.parse(await fs.readFile(path.join(languageDirectory, "search.json"), "utf8"));
    const { revision: searchRevision, ...searchCore } = search;
    if (
      search.schemaVersion !== 2
      || search.language !== languageEntry.code
      || contentRevision(searchCore) !== searchRevision
      || searchRevision !== languageIndex.search?.revision
      || languageIndex.search?.href !== `search.json?v=${revisionToken(searchRevision)}`
      || languageIndex.search?.songCount !== songIds.size
      || JSON.stringify(search.songs) !== JSON.stringify(expectedSearchRecords)
    ) {
      fail(`Multilingual search index does not match for ${languageEntry.code}`);
    }
  }
  if (!languageCodes.has(LANGUAGE)) fail("Multilingual catalog is missing its default language");
}

async function validateCatalog(directory, rawStats) {
  const catalogDirectory = path.join(directory, "catalog");
  const manifest = JSON.parse(await fs.readFile(path.join(catalogDirectory, "index.json"), "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.currentVersion !== CATALOG_VERSION) {
    fail("catalog/index.json has an unsupported or malformed schema");
  }
  const expectedIndexHref = `${CATALOG_VERSION}/index.json?v=${revisionToken(manifest.revision)}`;
  if (manifest.href !== expectedIndexHref) fail("catalog/index.json has an invalid version URL");

  const versionDirectory = path.join(catalogDirectory, CATALOG_VERSION);
  const index = JSON.parse(await fs.readFile(path.join(versionDirectory, "index.json"), "utf8"));
  if (index.schemaVersion !== 1 || !Array.isArray(index.collections)) {
    fail(`${CATALOG_VERSION}/index.json has an unsupported or malformed schema`);
  }
  const { revision: indexRevision, ...indexCore } = index;
  if (contentRevision(indexCore) !== indexRevision || manifest.revision !== indexRevision) {
    fail("Catalog index revision does not match its content");
  }

  const collectionIds = new Set();
  const songIds = new Set();
  const expectedSearchRecords = [];
  let songs = 0;
  let playableSongs = 0;
  let recordings = 0;
  for (const collection of index.collections) {
    if (collectionIds.has(collection.id)) fail(`Duplicate catalog collection ID: ${collection.id}`);
    collectionIds.add(collection.id);
    const expectedHref = `collections/${collection.slug}.json?v=${revisionToken(collection.revision)}`;
    if (collection.href !== expectedHref) {
      fail(`Unsafe or unexpected catalog path for ${collection.id}`);
    }
    const collectionPath = collection.href.split("?", 1)[0];
    const payload = JSON.parse(await fs.readFile(path.join(versionDirectory, collectionPath), "utf8"));
    if (payload.schemaVersion !== 1 || payload.collection?.id !== collection.id || !Array.isArray(payload.songs)) {
      fail(`Malformed compact collection: ${collection.id}`);
    }
    if (JSON.stringify(payload.collection) !== JSON.stringify(collection)) {
      fail(`Collection metadata differs between the index and payload: ${collection.id}`);
    }
    const payloadCore = {
      schemaVersion: payload.schemaVersion,
      collection: collectionCore(payload.collection),
      songs: payload.songs,
    };
    if (contentRevision(payloadCore) !== payload.revision || payload.revision !== collection.revision) {
      fail(`Catalog revision mismatch: ${collection.id}`);
    }
    if (payload.songs.length !== collection.songCount) fail(`Catalog song count mismatch: ${collection.id}`);
    for (const song of payload.songs) {
      if (song.id !== `${collection.id}:${song.slug}` || songIds.has(song.id)) {
        fail(`Invalid or duplicate catalog song ID: ${song.id}`);
      }
      songIds.add(song.id);
      expectedSearchRecords.push(searchRecord(song, collection.id));
      songs += 1;
      playableSongs += Number(song.recordings.length > 0);
      for (const recording of song.recordings) {
        if (!recording.id?.startsWith(`${song.id}:`) || !recording.url?.startsWith("https://")) {
          fail(`Invalid compact recording for ${song.id}`);
        }
      }
      recordings += song.recordings.length;
    }
  }

  const stats = { collections: collectionIds.size, songs, playableSongs, recordings };
  for (const key of Object.keys(stats)) {
    if (stats[key] !== rawStats[key]) fail(`Raw and compact ${key} counts do not match`);
  }
  if (
    index.stats?.collectionCount !== stats.collections
    || index.stats?.songCount !== stats.songs
    || index.stats?.playableSongCount !== stats.playableSongs
  ) {
    fail(`${CATALOG_VERSION}/index.json summary counts do not match its collections`);
  }

  const expectedSearchHref = `search.json?v=${revisionToken(index.search?.revision || "")}`;
  if (index.search?.href !== expectedSearchHref || index.search?.songCount !== songs) {
    fail("Catalog search metadata is invalid");
  }
  const search = JSON.parse(await fs.readFile(path.join(versionDirectory, "search.json"), "utf8"));
  const searchCore = { schemaVersion: search.schemaVersion, songs: search.songs };
  if (
    search.schemaVersion !== 1
    || contentRevision(searchCore) !== search.revision
    || search.revision !== index.search.revision
    || JSON.stringify(search.songs) !== JSON.stringify(expectedSearchRecords)
  ) {
    fail("Catalog search index does not match the collection data");
  }
  await validateMultilingualCatalog(catalogDirectory, manifest);
  return stats;
}

async function buildCatalog(directory, suppliedArtworkFallbacks) {
  const artworkFallbacks = suppliedArtworkFallbacks || await loadArtworkFallbacks(directory);
  const main = JSON.parse(await fs.readFile(path.join(directory, "main.json"), "utf8"));
  const collections = [...collectCollections(main.data.libraryData).values()];
  const catalogDirectory = path.join(directory, "catalog");
  const staging = path.join(directory, `.catalog-build-${process.pid}`);
  const backup = path.join(directory, `.catalog-backup-${process.pid}`);
  const versionDirectory = path.join(staging, CATALOG_VERSION);
  const collectionDirectory = path.join(versionDirectory, "collections");
  await fs.rm(staging, { recursive: true, force: true });

  try {
    await fs.mkdir(collectionDirectory, { recursive: true });
    const indexCollections = [];
    const searchRecords = [];
    let preservedArtworkCount = 0;
    for (const collection of collections) {
      const raw = JSON.parse(await fs.readFile(path.join(directory, "api", `${collection.slug}.json`), "utf8"));
      const songs = raw.data.map((song) => normalizeSong(song, collection.slug));
      const playableSongCount = songs.filter((song) => song.recordings.length > 0).length;
      const sourceArtworkUrl = collectionArtworkUrl(collection, new Map(), songs[0]?.artworkUrl);
      const artworkUrl = sourceArtworkUrl || artworkFallbacks.get(collection.slug) || null;
      if (!sourceArtworkUrl && artworkUrl) preservedArtworkCount += 1;
      const core = {
        id: collection.slug,
        slug: collection.slug,
        title: collection.title,
        ...(artworkUrl ? { artworkUrl } : {}),
        sourceUrl: `https://www.churchofjesuschrist.org/media/music/collections/${collection.slug}?lang=eng`,
        songCount: songs.length,
        playableSongCount,
      };
      const payloadCore = { schemaVersion: 1, collection: core, songs };
      const revision = contentRevision(payloadCore);
      const item = {
        ...core,
        revision,
        href: `collections/${collection.slug}.json?v=${revisionToken(revision)}`,
      };
      indexCollections.push(item);
      searchRecords.push(...songs.map((song) => searchRecord(song, collection.slug)));
      await fs.writeFile(
        path.join(collectionDirectory, `${collection.slug}.json`),
        `${JSON.stringify({ ...payloadCore, revision, collection: item })}\n`,
      );
    }

    if (preservedArtworkCount > 0) {
      console.log(`Preserved last known artwork for ${preservedArtworkCount} collections omitted upstream.`);
    }

    const searchCore = { schemaVersion: 1, songs: searchRecords };
    const searchRevision = contentRevision(searchCore);
    const search = { ...searchCore, revision: searchRevision };
    await fs.writeFile(path.join(versionDirectory, "search.json"), `${JSON.stringify(search)}\n`);

    const stats = {
      collectionCount: indexCollections.length,
      songCount: indexCollections.reduce((sum, item) => sum + item.songCount, 0),
      playableSongCount: indexCollections.reduce((sum, item) => sum + item.playableSongCount, 0),
    };
    const indexCore = {
      schemaVersion: 1,
      language: LANGUAGE,
      collections: indexCollections,
      stats,
      search: {
        revision: searchRevision,
        href: `search.json?v=${revisionToken(searchRevision)}`,
        songCount: searchRecords.length,
      },
    };
    const indexRevision = contentRevision(indexCore);
    await fs.writeFile(
      path.join(versionDirectory, "index.json"),
      `${JSON.stringify({ ...indexCore, revision: indexRevision })}\n`,
    );
    const multilingual = await buildMultilingualCatalog(directory, staging, artworkFallbacks);
    await fs.writeFile(
      path.join(staging, "index.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        currentVersion: CATALOG_VERSION,
        revision: indexRevision,
        href: `${CATALOG_VERSION}/index.json?v=${revisionToken(indexRevision)}`,
        multilingual: {
          schemaVersion: 2,
          revision: multilingual.revision,
          href: `${MULTILINGUAL_CATALOG_VERSION}/index.json?v=${revisionToken(multilingual.revision)}`,
          languageCount: multilingual.languages,
        },
      })}\n`,
    );

    await fs.rm(backup, { recursive: true, force: true });
    let hadCatalog = true;
    try {
      await fs.rename(catalogDirectory, backup);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      hadCatalog = false;
    }
    try {
      await fs.rename(staging, catalogDirectory);
    } catch (error) {
      if (hadCatalog) await fs.rename(backup, catalogDirectory);
      throw error;
    }
    if (hadCatalog) await fs.rm(backup, { recursive: true, force: true });
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

async function refreshLanguageSnapshot(staging, language) {
  const targetDirectory = languageSourceDirectory(staging, language.code);
  await fs.mkdir(path.join(targetDirectory, "api"), { recursive: true });
  const libraryUrl = new URL("https://www.churchofjesuschrist.org/media/music");
  libraryUrl.searchParams.set("lang", language.code);
  const html = await (await fetchWithRetry(libraryUrl)).text();
  const main = parseRenderData(html);
  if (main?.envData?.lang !== language.code) {
    fail(`Music library returned ${main?.envData?.lang || "an unknown language"} for ${language.code}`);
  }
  const collections = [...collectCollections(main?.data?.libraryData).values()];
  console.log(`Refreshing ${collections.length} ${language.name} collections...`);
  await fs.writeFile(path.join(targetDirectory, "main.json"), JSON.stringify(main));
  const payloads = await mapConcurrent(collections, CONCURRENCY, async (collection, index) => {
    const payload = await fetchCollection(collection.slug, language.code);
    console.log(`[${language.code} ${index + 1}/${collections.length}] ${collection.slug}: ${payload.total}`);
    return { collection, payload };
  });

  const fallbackGroups = new Map();
  for (const entry of payloads) {
    for (const song of entry.payload.data) {
      if (!shouldFetchSongPage(song, language.code)) continue;
      const group = fallbackGroups.get(song.slug) || [];
      group.push(song);
      fallbackGroups.set(song.slug, group);
    }
  }
  const fallbackEntries = [...fallbackGroups.entries()];
  console.log(`Checking ${fallbackEntries.length} ${language.name} song pages for fallback media...`);
  await mapConcurrent(fallbackEntries, CONCURRENCY, async ([slug, songs], index) => {
    const pageAssets = await fetchSongPageAssets(slug, language.code);
    let added = 0;
    for (const original of songs) {
      const merged = mergePageAssets(original, pageAssets);
      added += (merged.assets || []).length - (original.assets || []).length;
      if (merged !== original) Object.assign(original, merged);
    }
    console.log(`[${language.code} page ${index + 1}/${fallbackEntries.length}] ${slug}: ${added} fallback asset${added === 1 ? "" : "s"}`);
  });

  await Promise.all(payloads.map(({ collection, payload }) => fs.writeFile(
    path.join(targetDirectory, "api", `${collection.slug}.json`),
    JSON.stringify(payload, null, 2),
  )));
  return validateSnapshot(targetDirectory);
}

async function availableSnapshotStats(directory) {
  const results = new Map();
  for (const language of CATALOG_LANGUAGES) {
    const sourceDirectory = languageSourceDirectory(directory, language.code);
    try {
      results.set(language.code, await validateSnapshot(sourceDirectory));
    } catch (error) {
      if (error.code === "ENOENT" && !language.default) continue;
      throw error;
    }
  }
  return results;
}

async function refresh() {
  const artworkFallbacks = await loadArtworkFallbacks(DATA_DIRECTORY);
  const staging = path.join(ROOT, `.sacredmusic-refresh-${process.pid}`);
  const backup = path.join(ROOT, `.sacredmusic-backup-${process.pid}`);
  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(staging, { recursive: true });
  try {
    const statsByLanguage = new Map();
    for (const language of CATALOG_LANGUAGES) {
      statsByLanguage.set(language.code, await refreshLanguageSnapshot(staging, language));
    }
    await buildCatalog(staging, artworkFallbacks);
    await validateCatalog(staging, statsByLanguage.get(LANGUAGE));
    await fs.rm(backup, { recursive: true, force: true });
    await fs.rename(DATA_DIRECTORY, backup);
    try {
      await fs.rename(staging, DATA_DIRECTORY);
    } catch (error) {
      await fs.rename(backup, DATA_DIRECTORY);
      throw error;
    }
    await fs.rm(backup, { recursive: true, force: true });
    const summary = [...statsByLanguage.entries()]
      .map(([language, stats]) => `${language}: ${stats.collections} collections, ${stats.songs} songs`)
      .join("; ");
    console.log(`Published multilingual snapshot (${summary}).`);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

async function main() {
  const command = process.argv[2] || "refresh";
  if (command === "refresh") {
    await refresh();
  } else if (command === "validate") {
    const statsByLanguage = await availableSnapshotStats(DATA_DIRECTORY);
    const stats = await validateCatalog(DATA_DIRECTORY, statsByLanguage.get(LANGUAGE));
    const languages = [...statsByLanguage.keys()].join(", ");
    console.log(`Valid: ${stats.collections} collections, ${stats.songs} songs, ${stats.recordings} recordings (${languages}).`);
  } else if (command === "build") {
    const statsByLanguage = await availableSnapshotStats(DATA_DIRECTORY);
    await buildCatalog(DATA_DIRECTORY);
    await validateCatalog(DATA_DIRECTORY, statsByLanguage.get(LANGUAGE));
    console.log(`Rebuilt sacredmusic/catalog for ${[...statsByLanguage.keys()].join(", ")}.`);
  } else {
    fail(`Unknown command: ${command}. Use refresh, validate, or build.`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  collectionArtworkUrl,
  isPlaybackAsset,
  languageRecordingAssets,
  mergePageAssets,
  recordingAssets,
  parseRenderData,
  reconcileCollectionAttempts,
  shouldFetchSongPage,
  songAvailableInLanguage,
  songPageAssets,
  songPageUrl,
};
