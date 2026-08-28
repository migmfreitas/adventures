# adventure.log

A personal adventure map for GPX tracks from cycling, hiking, kayaking, and more.
Runs entirely in the browser — no server, no database. Routes live as files in the repo and deploy via GitHub Pages. A GitHub Action rebuilds the index automatically whenever you upload a GPX.

## Adding a route

### Option A — the admin portal (recommended)

Open **[`admin.html`](admin.html)** on the live site. It's a small client-side
portal that commits straight to this repo using a GitHub personal access
token you supply (stored only in your browser's local storage — never sent
anywhere but `api.github.com`):

1. Paste in a [fine-grained token](https://github.com/settings/personal-access-tokens/new)
   scoped to **this repo only**, with **Contents: Read and write** permission.
2. Drop a `.gpx` file, pick the activity type and (optionally) a collection,
   and add a description and photos if you want them.
3. Hit **Commit route**. The page parses the GPX, computes the same metrics
   `build-index.js` would, and pushes the GPX file plus an updated
   `data/index.json` (and `data/collections.json` for a new collection) as a
   single commit. Because the commit message starts with `Add route:`, the
   GitHub Action skips re-running — the index is already up to date.
4. The route is live in about 60 seconds.

The **Existing routes** panel further down the portal lists everything on
the map (click **Load** — `data/index.json` isn't fetched until you ask for
it). From there you can **edit** a route — rename it, move it between
collections, replace its track, add or remove photos, change the
description — or **delete** it outright. Both are single commits too;
renaming or moving a route relocates its GPX/photo files in the same
commit rather than re-uploading them.

### Option B — manual upload

The folder a GPX file lives in drives everything, so you can still add
routes by hand through the GitHub UI:

```
data/gpx/<type>/<filename>.gpx                 → standalone route
data/gpx/<type>/ungrouped/<filename>.gpx        → also standalone
data/gpx/<type>/<Collection Name>/<NNN-name>.gpx → part of a multi-day collection
```

- Valid `<type>` values: `bike`, `hike`, `kayak`, `run`. Anything else → `other`.
- The filename becomes the route name (title-cased, leading numbers like
  `001-` stripped): `001-Stage 1 - Porto to Vagueira.gpx` → "Stage 1 - Porto To Vagueira".
- A leading number (`001-`, `002-`, …) controls ordering within a collection.
- To add a new collection or set its description, add an entry to
  `data/collections.json` (`folder` must match the folder name exactly).

Upload via **github.com → this repo → `data/gpx/…` → Add file → Upload
files → Commit changes**. The Action then parses every GPX file and rebuilds
`data/index.json` automatically — live in about 60 seconds.

### Descriptions & photos

Every route can carry an optional `description` and a `photos` array
(paths under `data/images/<route-id>/`) — the admin portal writes these for
you, and they render on the route's detail page. Adding them by hand means
editing the route's entry in `data/index.json` directly (it's otherwise
auto-generated, so per-route `description`/`photos` are the only fields
`build-index.js` preserves rather than overwrites on rebuild).

---

## Deploy to GitHub Pages

1. Create a repo on GitHub (e.g. `adventures`)
2. Upload all files, keeping the folder structure:
   ```
   .github/
     workflows/update-index.yml
     scripts/build-index.js
   data/
     index.json
     gpx/
   js/
   index.html
   route.html
   .nojekyll
   ```
3. Go to repo **Settings → Pages → Source: main branch, / (root)** → Save
4. Your site is live at `https://yourusername.github.io/adventures/`

---

## File structure

```
.github/
  workflows/
    update-index.yml    ← runs on every GPX upload, calls build-index.js
  scripts/
    build-index.js      ← parses all GPX files, writes data/index.json
data/
  index.json            ← auto-generated manifest (description/photos survive rebuilds)
  collections.json      ← multi-day collection names, descriptions, ordering
  gpx/                  ← GPX files, organized data/gpx/<type>/[<collection>|ungrouped]/
  images/                ← photos uploaded via the admin portal, data/images/<route-id>/
js/
  gpx-parser.js         ← browser-side GPX parser (route page + admin portal)
  store.js              ← fetches data/index.json and data/gpx/*.gpx
  app.js                ← map, sidebar, filters
  admin.js               ← admin portal logic (commits via the GitHub API)
index.html              ← overview map
route.html              ← individual route: metrics, elevation profile, full map, description/photos
admin.html              ← admin portal: add routes with descriptions and photos
.nojekyll               ← disables Jekyll on GitHub Pages
```

## Metrics extracted

Distance · Elevation gain/loss · Max/min elevation · Moving time · Total time · Average speed · Average heart rate (if recorded) · GPS point count · Elevation profile · Simplified path for overview map
