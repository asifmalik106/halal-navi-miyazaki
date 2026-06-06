# Driving-distance map

A single public webpage that shows a set of map points, each labeled with its
**driving distance and driving time from one fixed reference point**.

- **Map:** Leaflet + OpenStreetMap tiles (free, no API key, no billing).
- **Distances:** computed once at build time via the OpenRouteService Matrix API.
- **Storage:** a single public GitHub Gist (`data.json`).
- **The public page makes zero routing API calls** — it only reads the Gist.
- **Host:** any static host (e.g. Cloudflare Pages). Only `index.html` is deployed.

## How it works

```
points.json  ──>  node build.js  ──>  ORS Matrix API  ──>  data.json  ──>  GitHub Gist
                                                                              │
                                                                  index.html reads the raw URL
```

1. You edit `points.json` (the reference point + a list of points).
2. You run `node build.js`. It calls ORS **once** for the whole list, then
   PATCHes the result into your Gist as `data.json`.
3. `index.html` fetches the Gist's raw URL and renders the map + a list.

Only you edit the data; everyone else just views the page.

## Files

| File            | Purpose                                                    |
| --------------- | ---------------------------------------------------------- |
| `points.json`   | Your editable source data (reference + points). No secrets.|
| `build.js`      | Node script: ORS Matrix → Gist. No runtime dependencies.   |
| `index.html`    | The public page (Leaflet). The only file you deploy.       |
| `.env.example`  | Documents the required env vars.                           |
| `.gitignore`    | Ignores `.env`.                                            |

## Setup

You need **Node 18+** (uses native `fetch` and `--env-file`). Check with `node --version`.

### 1. Get an OpenRouteService API key (free)

Sign up at <https://openrouteservice.org/dev/#/signup> — no credit card. Create a
token; the free tier's Matrix quota is plenty for a small list of points.

### 2. Create a public Gist

Go to <https://gist.github.com>, create a **public** gist with one file named
`data.json` and placeholder content `{}`. After saving, note two things:

- The **Gist ID** — the hash in the URL: `https://gist.github.com/<user>/<GIST_ID>`
- The **raw URL** of `data.json` — click the **Raw** button on the file; the URL
  looks like `https://gist.githubusercontent.com/<user>/<GIST_ID>/raw/data.json`.

### 3. Create a GitHub token with `gist` scope only

<https://github.com/settings/tokens> → generate a token and grant it **only** the
`gist` scope. (A fine-grained token with Gists read/write access also works.)

### 4. Configure your environment

```sh
cp .env.example .env
```

Fill in `ORS_API_KEY`, `GITHUB_TOKEN`, and `GIST_ID` in `.env`.
`.env` is gitignored — **never commit it**.

### 5. Edit your points and build

Edit `points.json`:

```json
{
  "reference": { "name": "My office", "lat": 35.6809, "lng": 139.7673 },
  "points": [
    { "name": "Place A", "lat": 35.7100, "lng": 139.7700 },
    { "name": "Place B", "lat": 35.6500, "lng": 139.8000 }
  ]
}
```

Then run:

```sh
node --env-file=.env build.js
# (or just: node build.js  — build.js also reads .env on its own)
```

On success it prints a summary table and the Gist **raw URL**.

### 6. Point the page at your Gist

Open `index.html` and set `GIST_RAW_URL` in the `CONFIG` block (near the top of
the `<script>`) to the raw URL from step 2 / step 5:

```js
const CONFIG = {
  GIST_RAW_URL: "https://gist.githubusercontent.com/<user>/<GIST_ID>/raw/data.json",
};
```

No tokens or keys go in `index.html` — it is public.

### 7. Deploy

Deploy `index.html` to Cloudflare Pages (or any static host). With Cloudflare
Pages you can connect the repo or drag-and-drop the file; the build command can
be left empty since there's nothing to compile.

### 8. Updating later

Edit `points.json` → `node build.js`. The page picks up new data automatically
(see the caching note below). You don't need to redeploy `index.html` unless you
change the page itself.

## Notes & gotchas

- **Coordinate order is `[lng, lat]` for ORS** — backwards order puts everything
  in the ocean. `build.js` handles this; just keep `points.json` as `lat`/`lng`.
- **Auth headers differ:** ORS uses the **raw** API key in `Authorization` (no
  `Bearer`); GitHub uses `Authorization: Bearer <token>`.
- **Gist raw URLs are CDN-cached.** A freshly pushed update can take a few
  minutes to appear for the public. That's fine here since edits are rare. To
  force-bust it you can append `?t=<timestamp>` to the raw URL.
- **The page reads the raw Gist URL, not the GitHub API.** The API has a
  60 req/hr/IP unauthenticated limit; the raw URL is CDN-backed with no
  per-visitor limit.
- **Distances are driving distance/time** (ORS `driving-car` profile), rounded to
  1 decimal km and whole minutes.
