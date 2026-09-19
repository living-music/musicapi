const test = require("node:test");
const assert = require("node:assert/strict");
const {
  collectionArtworkUrl,
  isPlaybackAsset,
  mergePageAssets,
  parseRenderData,
  recordingAssets,
  reconcileCollectionAttempts,
  shouldFetchSongPage,
  songPageAssets,
  songPageUrl,
} = require("./fetchProcess");

function renderData(song) {
  return `<html><script>window.renderData = ${JSON.stringify({ data: {
    slugName: song.slug,
    songData: song,
    sendToError: false,
  } })};</script></html>`;
}

test("collection artwork falls back when an upstream refresh omits its thumbnail", () => {
  const oldUrl = "https://images.example/old.jpg";
  assert.equal(collectionArtworkUrl({ slug: "album" }, new Map([["album", oldUrl]])), oldUrl);
  assert.equal(collectionArtworkUrl({
    slug: "album",
    bookThumbnail: { distributionUrl: "https://images.example/current.jpg" },
  }, new Map([["album", oldUrl]])), "https://images.example/current.jpg");
});

test("collection artwork uses the first song when its thumbnail is missing or unavailable", () => {
  const songUrl = "https://images.example/first-song.jpg";
  assert.equal(collectionArtworkUrl({ slug: "album" }, new Map(), songUrl), songUrl);
  assert.equal(collectionArtworkUrl({
    slug: "album",
    bookThumbnail: {
      distributionUrl: "https://images.example/canonical.jpg",
      renditions: [{ distributionUrl: "https://images.example/unavailable.jpg" }],
    },
  }, new Map(), songUrl, new Set(["https://images.example/unavailable.jpg"])), songUrl);
});

test("parseRenderData accepts whitespace around the page assignment", () => {
  assert.deepEqual(parseRenderData(renderData({ slug: "song", assets: [] })).data.songData.assets, []);
});

test("songPageAssets keeps playable audio and video downloads only", () => {
  const assets = songPageAssets(renderData({
    slug: "song",
    assets: [
      { assetType: "VIDEO", distributionUrl: "https://media.example/song.mp4" },
      { assetType: "AUDIO_VOCAL", distributionUrl: "https://media.example/song.mp3" },
      { assetType: "PDF", distributionUrl: "https://media.example/song.pdf" },
      { assetType: "VIDEO", distributionUrl: "http://media.example/insecure.mp4" },
    ],
  }), "song");
  assert.deepEqual(assets.map((asset) => asset.assetType), ["VIDEO", "AUDIO_VOCAL"]);
  assert.throws(() => songPageAssets(renderData({ slug: "other", assets: [] }), "song"), /unexpected render data/);
});

test("songPageAssets accepts a valid legacy page with empty song data", () => {
  const html = `<script>window.renderData=${JSON.stringify({ data: {
    slugName: "legacy-song",
    songData: {},
    sendToError: false,
  } })}</script>`;
  assert.deepEqual(songPageAssets(html, "legacy-song"), []);
});

test("mergePageAssets preserves source assets and deduplicates media URLs", () => {
  const song = { assets: [{ assetType: "PDF", distributionUrl: "https://media.example/song.pdf" }] };
  const video = { assetType: "VIDEO", distributionUrl: "https://media.example/song.mp4" };
  const merged = mergePageAssets(song, [video, video]);
  assert.deepEqual(merged.assets, [song.assets[0], video]);
  assert.equal(isPlaybackAsset(merged.assets[0]), false);
  assert.equal(isPlaybackAsset(merged.assets[1]), true);
});

test("direct audio takes priority over fallback video recordings", () => {
  const audio = { assetType: "AUDIO_VOCAL", distributionUrl: "https://media.example/song.mp3" };
  const video = { assetType: "VIDEO", distributionUrl: "https://media.example/song.mp4" };
  assert.deepEqual(recordingAssets([video, audio]), [audio]);
  assert.deepEqual(recordingAssets([video]), [video]);
});

test("page fallback targets songs without direct audio that may have other media", () => {
  assert.equal(shouldFetchSongPage({ assets: [], videoAvailable: true, sheetMusicAvailable: false }), true);
  assert.equal(shouldFetchSongPage({ assets: [], videoAvailable: false, sheetMusicAvailable: false }), true);
  assert.equal(shouldFetchSongPage({ assets: [], videoAvailable: false, sheetMusicAvailable: true }), false);
  assert.equal(shouldFetchSongPage({
    assets: [{ assetType: "AUDIO_VOCAL", distributionUrl: "https://media.example/song.mp3" }],
    videoAvailable: true,
  }), false);
});

test("song page URLs encode slugs and keep the catalog language", () => {
  assert.equal(
    songPageUrl("a song").href,
    "https://www.churchofjesuschrist.org/media/music/songs/a%20song?lang=eng",
  );
});

test("collection retries prefer a complete response", () => {
  const partial = { data: [{ slug: "one" }], reportedTotal: 2 };
  const complete = { data: [{ slug: "one" }, { slug: "two" }], reportedTotal: 2 };
  assert.deepEqual(reconcileCollectionAttempts("album", [partial, complete]), {
    data: complete.data,
    total: 2,
  });
});

test("stable incomplete collection retries reconcile a stale reported total", () => {
  const stableSongs = [{ slug: "one" }, { slug: "two" }];
  const resolved = reconcileCollectionAttempts("album", [
    { data: stableSongs, reportedTotal: 3 },
    { data: stableSongs.map((song) => ({ ...song })), reportedTotal: 3 },
    { data: stableSongs.map((song) => ({ ...song })), reportedTotal: 3 },
  ]);
  assert.deepEqual(resolved, { data: stableSongs.map((song) => ({ ...song })), total: 2 });
});

test("conflicting incomplete collection retries fail safely", () => {
  assert.throws(() => reconcileCollectionAttempts("album", [
    { data: [{ slug: "one" }], reportedTotal: 3 },
    { data: [{ slug: "two" }], reportedTotal: 3 },
    { data: [{ slug: "three" }], reportedTotal: 3 },
  ]), /inconsistent incomplete results after 3 attempts: 1\/3, 1\/3, 1\/3/);
});
