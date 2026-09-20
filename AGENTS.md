# Instructions for AI agents

## Repository purpose

This repository is a read-only metadata mirror and catalog builder for static music clients. It must never contain downloaded audio, authentication material, or a runtime proxy. The Church hosts the media; this repository records public metadata and HTTPS URLs.

## Working rules

- Read `README.md` and inspect `git status` before editing.
- Preserve unrelated user changes. Do not rewrite or discard generated snapshots unless the task requires a refresh or catalog rebuild.
- Treat `fetchProcess.js` as the source of truth. Files under `sacredmusic/` are generated outputs and should not be edited by hand.
- Keep the project dependency-free unless a requested change cannot reasonably be implemented with Node.js built-ins.
- Treat `/sacredmusic/main.json` and `/sacredmusic/api/<slug>.json` as internal build inputs. Do not add them to the GitHub Pages artifact.
- Keep app-facing data under `/sacredmusic/catalog/`. Breaking changes require a new version directory such as `v2`; preserve released version directories until the owner explicitly retires them.
- Keep the root catalog `index.json` as a small discovery document. Every version must provide an index, a global search index, and collection payloads with deterministic revision hashes.
- Maintain stable song IDs (`<collection-slug>:<song-slug>`). If upstream identifiers change, add an explicit migration strategy before changing stored IDs.
- Never select a recording by array position. Recording type and listener preference determine playback defaults.
- Preserve direct `AUDIO_*` priority. Page-level `VIDEO` assets are playback fallbacks only when the collection API has no direct audio; PDFs are never recordings.
- Keep multilingual source snapshots separate under `sacredmusic/languages/<language>/`; English retains its legacy root layout.
- Keep English as schema v2's complete baseline, including instrumental songs and songs without playback. For each additional language, only an explicitly matching `AUDIO_VOCAL*` or `VIDEO` asset may establish song availability. Accompaniment and instrumental assets never qualify a translated song by themselves, and translated payloads must not expose recordings tagged for another language.
- Do not copy audio or artwork into the repository. Do not claim that availability implies permission to redistribute or reuse an asset.

## Verification

Use Node.js 24 or newer.

```sh
npm test
npm run validate
npm run build
git diff --check
```

After `npm run build`, run `npm run validate` again and inspect the generated diff. For importer changes, use `npm run refresh` only when network access and an upstream refresh are part of the task. A refresh must be all-or-nothing: failures must leave the last valid `sacredmusic/` snapshot in place.

Workflow changes must retain this order: refresh when appropriate, rebuild, validate, verify generated output on pushes, commit the exact scheduled snapshot, prepare the Pages artifact, then deploy. Scheduled refresh commits made with `GITHUB_TOKEN` do not trigger a second push workflow, so the originating run must perform deployment itself.

## Change notes

In handoff summaries, state whether the work changed importer behavior, raw mirrored data, versioned catalog schema, or public URLs. Report validation results and any checks that could not run.
