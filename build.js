#!/usr/bin/env node
// build.js — compute driving distance + duration from one reference point to a
// list of points using the OpenRouteService Matrix API, then PATCH the result
// into a GitHub Gist as data.json. The public page reads that Gist; it never
// touches a routing API. No runtime dependencies.
//
// Usage:
//   node --env-file=.env build.js
//   node build.js            (build.js also parses .env itself as a fallback)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const ORS_MATRIX_URL = "https://api.openrouteservice.org/v2/matrix/driving-car";
const GITHUB_API = "https://api.github.com";

// ---------------------------------------------------------------------------
// Tiny .env loader (fallback for when `node --env-file=.env` isn't used).
// Only sets vars that aren't already in the environment, so --env-file wins.
// ---------------------------------------------------------------------------
function loadDotEnv() {
  let raw;
  try {
    raw = readFileSync(join(__dirname, ".env"), "utf8");
  } catch {
    return; // no .env file — rely on the real environment
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // strip surrounding quotes if present
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

function die(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
function requireEnv() {
  const missing = ["ORS_API_KEY", "GITHUB_TOKEN", "GIST_ID"].filter(
    (k) => !process.env[k]
  );
  if (missing.length) {
    die(
      `Missing required env var(s): ${missing.join(", ")}.\n` +
        `  Copy .env.example to .env and fill them in, then run:\n` +
        `  node --env-file=.env build.js`
    );
  }
}

function isFiniteNumber(n) {
  return typeof n === "number" && Number.isFinite(n);
}

function validatePoint(p, where) {
  if (!p || typeof p !== "object") die(`${where}: must be an object.`);
  if (typeof p.name !== "string" || !p.name.trim())
    die(`${where}: missing a non-empty "name".`);
  if (!isFiniteNumber(p.lat) || p.lat < -90 || p.lat > 90)
    die(`${where} ("${p.name}"): "lat" must be a number between -90 and 90.`);
  if (!isFiniteNumber(p.lng) || p.lng < -180 || p.lng > 180)
    die(`${where} ("${p.name}"): "lng" must be a number between -180 and 180.`);
}

function readPoints() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(join(__dirname, "points.json"), "utf8"));
  } catch (err) {
    die(`Could not read/parse points.json: ${err.message}`);
  }
  validatePoint(parsed.reference, "reference");
  if (!Array.isArray(parsed.points) || parsed.points.length === 0)
    die(`points.json: "points" must be a non-empty array.`);
  parsed.points.forEach((p, i) => validatePoint(p, `points[${i}]`));
  return parsed;
}

// ---------------------------------------------------------------------------
// OpenRouteService Matrix call
// ---------------------------------------------------------------------------
async function callOrsMatrix({ reference, points }) {
  // NOTE: ORS expects [lng, lat] order. Index 0 = reference, 1..N = points.
  const locations = [
    [reference.lng, reference.lat],
    ...points.map((p) => [p.lng, p.lat]),
  ];
  const body = {
    locations,
    sources: [0],
    destinations: points.map((_, i) => i + 1),
    metrics: ["distance", "duration"],
    units: "km",
  };

  let res;
  try {
    res = await fetch(ORS_MATRIX_URL, {
      method: "POST",
      headers: {
        Authorization: process.env.ORS_API_KEY, // raw key, NO "Bearer"
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    die(`Network error calling OpenRouteService: ${err.message}`);
  }

  const text = await res.text();
  if (!res.ok) {
    die(
      `OpenRouteService returned ${res.status} ${res.statusText}:\n${text}`
    );
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    die(`OpenRouteService returned non-JSON response:\n${text}`);
  }

  const distances = json.distances?.[0];
  const durations = json.durations?.[0];
  if (!Array.isArray(distances) || !Array.isArray(durations)) {
    die(
      `Unexpected ORS response shape (no distances/durations):\n${JSON.stringify(
        json,
        null,
        2
      )}`
    );
  }
  return { distances, durations };
}

// ---------------------------------------------------------------------------
// Push to Gist
// ---------------------------------------------------------------------------
async function patchGist(output) {
  let res;
  try {
    res = await fetch(`${GITHUB_API}/gists/${process.env.GIST_ID}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, // GitHub uses Bearer
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "map-distance-build",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        files: { "data.json": { content: JSON.stringify(output, null, 2) } },
      }),
    });
  } catch (err) {
    die(`Network error calling GitHub: ${err.message}`);
  }

  const text = await res.text();
  if (!res.ok) {
    die(`GitHub returned ${res.status} ${res.statusText}:\n${text}`);
  }
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  loadDotEnv();
  requireEnv();

  const { reference, points } = readPoints();
  console.log(
    `→ Computing driving distances from "${reference.name}" to ${points.length} point(s)…`
  );

  const { distances, durations } = await callOrsMatrix({ reference, points });

  const outPoints = points.map((p, i) => {
    const km = distances[i];
    const durSec = durations[i];
    return {
      // ...p carries through any manual fields you set in points.json,
      // including `gmap` (Google Maps link) and `route` (directions link).
      ...p,
      km: km == null ? null : Math.round(km * 10) / 10, // 1 decimal place
      min: durSec == null ? null : Math.round(durSec / 60), // whole minutes
    };
  });

  const output = {
    updated: new Date().toISOString(),
    reference, // passes through reference.gmap if you set one
    points: outPoints,
  };

  console.log("→ Pushing data.json to Gist…");
  const gist = await patchGist(output);

  const rawUrl =
    gist.files?.["data.json"]?.raw_url ??
    `https://gist.githubusercontent.com/<user>/${process.env.GIST_ID}/raw/data.json`;

  // Summary table
  const nameWidth = Math.max(4, ...outPoints.map((p) => p.name.length));
  const pad = (s, w) => String(s).padEnd(w);
  const padL = (s, w) => String(s).padStart(w);
  console.log("\n✓ Done. Gist updated.\n");
  console.log(`  ${pad("name", nameWidth)}  ${padL("km", 7)}  ${padL("min", 5)}`);
  console.log(`  ${"-".repeat(nameWidth)}  ${"-".repeat(7)}  ${"-".repeat(5)}`);
  for (const p of outPoints) {
    console.log(
      `  ${pad(p.name, nameWidth)}  ${padL(p.km ?? "—", 7)}  ${padL(
        p.min ?? "—",
        5
      )}`
    );
  }

  console.log(`\n  Raw URL (put this in GIST_RAW_URL in index.html):`);
  console.log(`  ${rawUrl}\n`);
  console.log(
    `  Note: the raw URL is CDN-cached, so public viewers may see the update`
  );
  console.log(`  after a few minutes.\n`);
}

main().catch((err) => die(err?.stack || String(err)));
