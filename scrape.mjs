// Collects cinema showtimes (via cinebel.dhnet.be) + Letterboxd watchlist/watched films
// and writes data/cinema.json. No dependencies (Node 20+).
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { parseCinebel } from "./cinebel.mjs";

const LETTERBOXD_USER = process.env.LETTERBOXD_USER || "Nyrax";
const OUT = "data/cinema.json";
const EXPORT_DIR = "letterboxd-export";

// cinebel theater ids
const CINEMAS = [
  { id: 996, key: "pathe-sint-niklaas", name: "Pathé Sint-Niklaas", primary: true },
  { id: 993, key: "kinepolis-gent", name: "Kinepolis Gent" },
  { id: 994, key: "sphinx-gent", name: "Sphinx Cinema Gent" },
  { id: 995, key: "studio-skoop-gent", name: "Studio Skoop Gent" },
];

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "nl-BE,nl;q=0.9,en;q=0.8",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

async function get(url, { json = false, tries = 4 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.ok) return json ? await res.json() : await res.text();
      if (res.status === 404) return null;
      if (![403, 429, 500, 502, 503, 520, 521, 522].includes(res.status)) throw new Error(`HTTP ${res.status}`);
      console.warn(`${res.status} on ${url}, retrying`);
    } catch (e) {
      if (i === tries - 1) throw new Error(`${url}: ${e.message}`);
    }
    await sleep(5000 * 2 ** i);
  }
  throw new Error(`${url}: gave up after ${tries} tries`);
}

const decode = (s) =>
  s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

// ---------- Cinemas (cinebel) ----------
async function scrapeCinemas() {
  const out = [];
  const days = Array.from({ length: 14 }, (_, i) => `days=${i + 1}`).join("&");
  for (const c of CINEMAS) {
    try {
      const html = await get(`https://cinebel.dhnet.be/fr/theater/${c.id}?${days}`);
      const films = parseCinebel(html || "");
      if (!films.length) throw new Error("no films parsed");
      out.push({ ...c, films });
    } catch (e) {
      errors.push(`cinema ${c.name}: ${e.message}`);
      out.push({ ...c, films: null });
    }
    await sleep(1500);
  }
  return out;
}

// ---------- Letterboxd ----------
const norm = (s) =>
  (s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const splitName = (name) => {
  const m = (name || "").match(/^(.*)\s+\((\d{4})\)$/);
  return m ? { title: m[1], year: Number(m[2]) } : { title: name, year: null };
};
const keyOf = (title, year) => `${norm(title)}|${year ?? ""}`;

function lastPage(html) {
  const pages = [...html.matchAll(/\/page\/(\d+)\//g)].map((m) => Number(m[1]));
  return pages.length ? Math.max(...pages) : 1;
}

function parsePosters(html) {
  const chunks = html.split(/<li[^>]*class="[^"]*griditem/).slice(1);
  return chunks
    .map((c) => {
      const slug = c.match(/data-item-slug="([^"]+)"/)?.[1];
      const name = c.match(/data-item-name="([^"]+)"/)?.[1];
      if (!slug) return null;
      const viewing = c.split("poster-viewingdata")[1] || "";
      const rated = viewing.match(/rated-(\d+)/)?.[1];
      return {
        slug,
        name: name ? decode(name) : slug,
        rating: rated ? Number(rated) / 2 : null,
        liked: /liked-micro/.test(viewing),
      };
    })
    .filter(Boolean);
}

async function scrapeWatchlist() {
  const first = await get(`https://letterboxd.com/${LETTERBOXD_USER}/watchlist/`);
  if (!first) throw new Error("watchlist not found");
  const pages = [first];
  for (let p = 2; p <= lastPage(first); p++) {
    await sleep(2500 + Math.random() * 1500);
    pages.push(await get(`https://letterboxd.com/${LETTERBOXD_USER}/watchlist/page/${p}/`));
  }
  return pages.flatMap((h) => parsePosters(h || "")).map(({ slug, name }) => ({ slug, name }));
}

async function watchlistViaRoulette() {
  const data = await get(
    `https://watchlistroulette.com/api/watchlist?usernames=${encodeURIComponent(LETTERBOXD_USER)}`,
    { json: true },
  );
  const u = data?.users?.[0];
  if (!u || u.error) throw new Error(`watchlistroulette: ${u?.error || "no data"}`);
  return u.movies.map(({ slug, name }) => ({ slug, name }));
}

// Minimal CSV parser (handles quotes)
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') q = false;
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...rest] = rows.filter((r) => r.length > 1);
  if (!header) return [];
  return rest.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i]])));
}

async function readExport() {
  // Unzipped Letterboxd export (the workflow unzips any .zip in letterboxd-export/)
  const read = (f) => readFile(`${EXPORT_DIR}/${f}`, "utf8").then(parseCsv).catch(() => null);
  const [watched, ratings, likes, watchlist] = await Promise.all([
    read("watched.csv"),
    read("ratings.csv"),
    read("likes/films.csv"),
    read("watchlist.csv"),
  ]);
  return { watched, ratings, likes, watchlist, present: !!(watched || ratings) };
}

async function scrapeRecentActivity() {
  const items = [];
  // RSS: recent diary entries with ratings (works where paginated pages are blocked)
  try {
    const rss = await get(`https://letterboxd.com/${LETTERBOXD_USER.toLowerCase()}/rss/`);
    for (const it of (rss || "").split("<item>").slice(1)) {
      const title = it.match(/<letterboxd:filmTitle>([^<]*)/)?.[1];
      if (!title) continue;
      const year = Number(it.match(/<letterboxd:filmYear>(\d+)/)?.[1]) || null;
      const rating = Number(it.match(/<letterboxd:memberRating>([\d.]+)/)?.[1]) || null;
      const liked = /<letterboxd:memberLike>Yes/i.test(it);
      const slug = it.match(/<link>[^<]*\/film\/([^/<]+)\//)?.[1] || null;
      items.push({ slug, title: decode(title), year, rating, liked });
    }
  } catch (e) {
    errors.push(`letterboxd rss: ${e.message}`);
  }
  // First page of /films/ (most recent watches, with rating + like)
  try {
    const html = await get(`https://letterboxd.com/${LETTERBOXD_USER}/films/`);
    items.push(...parsePosters(html || ""));
  } catch (e) {
    errors.push(`letterboxd films page 1: ${e.message}`);
  }
  return items;
}

async function buildWatched(exp, previous) {
  const map = new Map();
  const upsert = ({ name, title, year, slug = null, rating = null, liked = false }) => {
    if (!title) ({ title, year } = splitName(name));
    if (!title) return;
    const k = keyOf(title, year);
    const cur = map.get(k) || { name: `${title}${year ? ` (${year})` : ""}`, slug: null, rating: null, liked: false };
    if (slug) cur.slug = slug;
    if (rating != null) cur.rating = rating;
    if (liked) cur.liked = true;
    map.set(k, cur);
  };
  for (const w of previous || []) upsert(w);
  for (const r of exp.watched || []) upsert({ title: r.Name, year: Number(r.Year) || null });
  for (const r of exp.ratings || []) upsert({ title: r.Name, year: Number(r.Year) || null, rating: Number(r.Rating) || null });
  for (const r of exp.likes || []) upsert({ title: r.Name, year: Number(r.Year) || null, liked: true });
  for (const r of await scrapeRecentActivity()) upsert(r);
  return [...map.values()];
}

// ---------- main ----------
const prev = await readFile(OUT, "utf8").then(JSON.parse).catch(() => ({}));
const exp = await readExport();

let cinemas = await scrapeCinemas();
// keep previous data for any cinema that failed this time
cinemas = cinemas.map((c) => {
  if (c.films) return { ...c, source: "fresh" };
  const old = (prev.cinemas || []).find((p) => p.key === c.key);
  return old ? { ...old, source: "stale" } : { ...c, source: "missing" };
});

let watchlist, watchlistSource;
try {
  watchlist = await scrapeWatchlist();
  watchlistSource = "letterboxd";
} catch (e) {
  errors.push(`watchlist direct: ${e.message}`);
  try {
    watchlist = await watchlistViaRoulette();
    watchlistSource = "watchlistroulette";
  } catch (e2) {
    errors.push(`watchlist roulette: ${e2.message}`);
    if (exp.watchlist?.length) {
      watchlist = exp.watchlist.map((r) => ({ slug: null, name: `${r.Name}${r.Year ? ` (${r.Year})` : ""}` }));
      watchlistSource = "export";
    } else {
      watchlist = prev.letterboxd?.watchlist || null;
      watchlistSource = "stale";
    }
  }
}

const watched = await buildWatched(exp, prev.letterboxd?.watched);

const out = {
  generatedAt: new Date().toISOString(),
  status: {
    cinemas: Object.fromEntries(cinemas.map((c) => [c.key, `${c.source}: ${c.films?.length ?? 0} films`])),
    watchlist: `${watchlistSource}: ${watchlist?.length ?? 0}`,
    watched: `${watched.length} films (${watched.filter((w) => w.rating != null).length} rated, ${watched.filter((w) => w.liked).length} liked); export ${exp.present ? "present" : "missing"}`,
    errors: errors.slice(0, 50),
  },
  cinemas,
  letterboxd: { user: LETTERBOXD_USER, watchlist, watched },
};

await mkdir("data", { recursive: true });
await writeFile(OUT, JSON.stringify(out, null, 1) + "\n");
console.log(JSON.stringify(out.status, null, 1));
