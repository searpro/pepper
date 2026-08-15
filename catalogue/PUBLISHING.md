# Publishing this to `searpro/pepper-catalogue`

Requirement 7 puts the catalogue in **its own repository**, so that adding a
model is a pull request there rather than a pepper release. This directory is
that repository's contents, staged here because the session that wrote it could
not create a repo under the `searpro` organization — its GitHub credential is
scoped to `searpro/pepper`.

Everything here is verified: all 16 models resolve against live HuggingFace
listings, and the whole install path was exercised against a running pepper
(manifest written, download queued, cancel leaving a resumable partial).

## To publish

Create an empty public repo named `pepper-catalogue` under `searpro`, then:

```bash
cd catalogue
git init -b main
git add pepper-catalogue.json validate.mjs README.md .github
git commit -m "Starter catalogue: 16 models across image, video, audio and text"
git remote add origin git@github.com:searpro/pepper-catalogue.git
git push -u origin main
```

Do **not** copy this file — it describes the staging, not the catalogue.

Once it is pushed, pepper picks it up with no change: `CATALOGUE_URL` already
defaults to

```
https://raw.githubusercontent.com/searpro/pepper-catalogue/main/pepper-catalogue.json
```

Delete this `catalogue/` directory from pepper afterwards, so there is only one
copy to keep current.

## Until then

Point a deployment at the staged copy on this branch:

```bash
CATALOGUE_URL=https://raw.githubusercontent.com/searpro/pepper/claude/sd-api-alpha-vr8x4k/catalogue/pepper-catalogue.json
```

Or serve it locally while developing:

```bash
cd catalogue && python3 -m http.server 4111
CATALOGUE_URL=http://localhost:4111/pepper-catalogue.json npm start
```

The default was deliberately left pointing at the standalone repo rather than at
this staged copy: the copy is temporary, and a default that outlives it would
quietly become the real catalogue.
