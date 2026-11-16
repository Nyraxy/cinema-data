// Collects Pathé Sint-Niklaas showtimes + Letterboxd watchlist/watched films
// and writes data/cinema.json. No dependencies (Node 20+).
import { readFile, writeFile } from "node:fs/promises";

const LETTERBOXD_USER = process.env.LETTERBOXD_USER || "Nyrax";
const PATHE_CINEMA = process.env.PATHE_CINEMA || "cinema-pathe-sint-niklaas";
const DAYS_AHEAD = Number(process.env.DAYS_AHEAD || 42);
const OUT = "data/cinema.json";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  Accept: "text/html,application/json;q=0.9,*/*;q=0.8",
  "Accept-Language": "nl-BE,nl;q=0.9,en;q=0.8",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

async function get(url, { json = false, tries = 3 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.ok) return json ? await res.json() : await res.text();
      if (res.status === 404) return null;
      if (![403, 429, 500, 502, 503, 520, 521, 522].includes(res.status)) {
        throw new Error(`HTTP ${res.status}`);
      }
      console.warn(`${res.status} on ${url}, retrying`);
    } catch (e) {
      if (i === tries - 1) throw new Error(`${url}: ${e.message}`);
    }
    await sleep(1500 * (i + 1));
  }
  throw new Error(`${url}: gave up after ${tries} tries`);
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

const decode = (s) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

// ---------- Pathé ----------
async function scrapePathe() {
  const base = "https://www.pathe.be";
  const list = await get(`${base}/api/cinema/${PATHE_CINEMA}/shows?language=nl`, { json: true });
  const today = new Date().toISOString().slice(0, 10);
  const limit = new Date(Date.now() + DAYS_AHEAD * 864e5).toISOString().slice(0, 10);

  const slugs = Object.keys(list.shows);
  const films = await pool(slugs, 4, async (slug) => {
    const meta = list.shows[slug];
    const days = Object.keys(meta.days || {}).filter((d) => d >= today && d <= limit).sort();
    let detail = {};
    try {
      detail = (await get(`${base}/api/show/${slug}?language=nl`, { json: true })) || {};
    } catch (e) {
      errors.push(`pathe detail ${slug}: ${e.message}`);
    }
    const showtimes = [];
    for (const day of days) {
      try {
        const times =
          (await get(`${base}/api/show/${slug}/showtimes/${PATHE_CINEMA}/${day}?language=nl`, {
            json: true,
          })) || [];
        for (const t of times) {
          showtimes.push({
            time: t.time, // local Brussels time, "YYYY-MM-DD HH:MM:SS"
            version: t.version,
            tags: t.tags,
            status: t.status,
          });
        }
      } catch (e) {
        errors.push(`pathe showtimes ${slug} ${day}: ${e.message}`);
      }
      await sleep(150);
    }
    return {
      slug,
      title: detail.title || slug,
      titleTracking: detail.titleTracking || null, // often the original/English title
      duration: detail.duration ? Number(detail.duration) : null,
      directors: detail.directors || null,
      genres: detail.genres || [],
      releaseAt: detail.releaseAt?.BE_NL || detail.releaseAt?.BE_FR || null,
      url: `${base}/nl/films/${slug}`,
      isNew: !!meta.isNew,
      isComingSoon: !!meta.isComingSoon,
      specialEvent: !!meta.specialEvent,
      allDays: Object.keys(meta.days || {}).sort(),
      showtimes,
    };
  });
  return { cinema: PATHE_CINEMA, films };
}

// ---------- Letterboxd ----------
function lastPage(html) {
  const pages = [...html.matchAll(/\/page\/(\d+)\//g)].map((m) => Number(m[1]));
  return pages.length ? Math.max(...pages) : 1;
}

function parsePosters(html) {
  // Each grid item is an <li class="griditem ..."> containing a react-component div
  // with data-item-slug / data-item-name, and (on /films/) a poster-viewingdata block.
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
        rating: rated ? Number(rated) / 2 : null, // stars, 0.5–5
        liked: /liked-micro/.test(viewing),
      };
    })
    .filter(Boolean);
}

async function scrapeLetterboxdList(path, { withViewing }) {
  const first = await get(`https://letterboxd.com/${LETTERBOXD_USER}/${path}/`);
  if (!first) throw new Error(`letterboxd ${path}: not found`);
  const n = lastPage(first);
  const pages = [first];
  for (let p = 2; p <= n; p++) {
    await sleep(700);
    pages.push(await get(`https://letterboxd.com/${LETTERBOXD_USER}/${path}/page/${p}/`));
  }
  const items = pages.flatMap((h) => parsePosters(h || ""));
  return withViewing ? items : items.map(({ slug, name }) => ({ slug, name }));
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

// ---------- main ----------
async function section(name, fn, previous) {
  try {
    const value = await fn();
    return { value, source: "fresh" };
  } catch (e) {
    errors.push(`${name}: ${e.message}`);
    console.error(`${name} failed: ${e.message}`);
    return { value: previous ?? null, source: previous ? "stale (kept previous)" : "missing" };
  }
}

const prev = await readFile(OUT, "utf8").then(JSON.parse).catch(() => ({}));

const pathe = await section("pathe", scrapePathe, prev.pathe);
const watchlist = await section(
  "letterboxd watchlist",
  async () => {
    try {
      return await scrapeLetterboxdList("watchlist", { withViewing: false });
    } catch (e) {
      errors.push(`letterboxd watchlist direct: ${e.message} (trying watchlistroulette)`);
      return await watchlistViaRoulette();
    }
  },
  prev.letterboxd?.watchlist,
);
const watched = await section(
  "letterboxd watched",
  () => scrapeLetterboxdList("films", { withViewing: true }),
  prev.letterboxd?.watched,
);

const out = {
  generatedAt: new Date().toISOString(),
  status: {
    pathe: pathe.source,
    watchlist: watchlist.source,
    watched: watched.source,
    errors: errors.slice(0, 50),
  },
  pathe: pathe.value,
  letterboxd: { user: LETTERBOXD_USER, watchlist: watchlist.value, watched: watched.value },
};

await writeFile(OUT, JSON.stringify(out, null, 1) + "\n");
console.log(
  `pathe films: ${out.pathe?.films?.length ?? 0}, watchlist: ${out.letterboxd.watchlist?.length ?? 0}, watched: ${out.letterboxd.watched?.length ?? 0}, errors: ${errors.length}`,
);
if (!pathe.value && !watchlist.value) process.exit(1);
