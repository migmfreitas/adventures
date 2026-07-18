# adventure.log

A personal adventure map for GPX tracks from cycling, hiking, kayaking, and more.
Runs entirely in the browser — no server, no database. Routes live as files in the repo and deploy via GitHub Pages. A GitHub Action rebuilds the index automatically whenever you upload a GPX.

## Adding a route

1. Name your GPX file using this convention:
   ```
   <type>-<name-with-dashes>.gpx
   ```
   Examples:
   ```
   bike-sintra-coastal-loop.gpx   → 🚴 Sintra Coastal Loop
   hike-serra-da-estrela.gpx      → 🥾 Serra Da Estrela
   kayak-douro-estuary.gpx        → 🛶 Douro Estuary
   run-porto-waterfront.gpx       → 🏃 Porto Waterfront
   my-random-adventure.gpx        → ✦ My Random Adventure  (no type prefix = "other")
   ```
   Valid type prefixes: `bike`, `hike`, `kayak`, `run`. Anything else → `other`.

2. Upload the file to **`data/gpx/`** in your GitHub repo:
   - Go to github.com → your repo → `data/gpx/`
   - Click **Add file → Upload files**
   - Drop the `.gpx` file in → **Commit changes**

3. GitHub automatically runs the Action, parses the GPX, and updates `data/index.json`.

4. ~60 seconds later the route appears on the live site. Done.

That's it — one file upload, everything else is automatic.

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
  index.json            ← auto-generated manifest (don't edit by hand)
  gpx/                  ← drop your GPX files here
js/
  gpx-parser.js         ← browser-side GPX parser (used by route detail page)
  store.js              ← fetches data/index.json and data/gpx/*.gpx
  app.js                ← map, sidebar, filters
index.html              ← overview map
route.html              ← individual route: metrics, elevation profile, full map
.nojekyll               ← disables Jekyll on GitHub Pages
```

## Metrics extracted

Distance · Elevation gain/loss · Max/min elevation · Moving time · Total time · Average speed · Average heart rate (if recorded) · GPS point count · Elevation profile · Simplified path for overview map
