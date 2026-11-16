// Parser for cinebel.dhnet.be theater pages (server-rendered HTML).
const strip = (s) =>
  s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&hellip;/g, "…")
    .replace(/\s+/g, " ")
    .trim();

function toIsoDate(ddmm, now = new Date()) {
  const [d, m] = ddmm.split("/").map(Number);
  let y = now.getFullYear();
  // dates in early next year shown in December
  if (m < now.getMonth() + 1 - 6) y += 1;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function parseCinebel(html, now = new Date()) {
  const blocks = html.split(/<h4[^>]*>/).slice(1);
  const films = [];
  for (const b of blocks) {
    if (!b.includes('class="schedulesItem"') && !b.includes("Horaires du film")) continue;
    const head = b.slice(0, b.indexOf("</h4>"));
    const originalTitle = head.match(/class="originalTitle"[^>]*>\s*\(([^)]*)\)/)?.[1]?.trim() || null;
    const title = strip(head.replace(/<span[^>]*class="originalTitle"[\s\S]*?<\/span>/, ""));
    const filmLink = b.match(/href="\s*(\/film\/(\d+)\/[^"]*?)\s*"/);
    const infos = b.match(/class="scheduleMovieInfos"[\s\S]*?<\/ul>/)?.[0] || "";
    const poster = infos.match(/<img[^>]+src="([^"]+)"/)?.[1] || null;
    const year = Number(infos.match(/-\s*(\d{4})\s*</)?.[1]) || null;
    const runtime = infos.match(/<li>\s*(\d+)h(\d{2})\s*<\/li>/);
    const directors = [...(b.match(/<p>\s*de\s+([\s\S]*?)(?:avec|<\/p>)/)?.[1] || "").matchAll(/>([^<]+)<\/a>/g)].map(
      (m) => m[1].trim(),
    );
    const showtimes = [];
    const tbody = b.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] || "";
    for (const row of tbody.split(/<tr[\s>]/).slice(1)) {
      const date = row.match(/<span class="date">\s*([\d/]+)/)?.[1];
      if (!date) continue;
      const version = row.match(/class="audioVersion\s+([A-Z]+)/)?.[1] || null;
      const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => strip(m[1]));
      const subtitles = (cells[0] || "").replace(/^(VO|VF|VN|DF)\s*/, "") || null;
      const hoursHtml = row.match(/class="hours"[^>]*>([\s\S]*?)<\/div>/)?.[1] || "";
      const times = [...hoursHtml.matchAll(/(\d{1,2}:\d{2})/g)].map((m) => m[1]);
      const rest = strip(row.slice(row.indexOf("hours")));
      const special = rest.match(/Sc[ée]ance sp[ée]ciale\s*(.*)$/i)?.[1]?.trim() || null;
      const iso = toIsoDate(date, now);
      for (const t of times) {
        showtimes.push({ time: `${iso} ${t.padStart(5, "0")}`, version, subtitles, special });
      }
    }
    const cinebelUrl = filmLink ? `https://cinebel.dhnet.be${encodeURI(decodeURI(filmLink[1].trim()))}` : null;
    films.push({
      title,
      originalTitle,
      year,
      duration: runtime ? Number(runtime[1]) * 60 + Number(runtime[2]) : null,
      directors,
      poster,
      cinebelId: filmLink ? Number(filmLink[2]) : null,
      url: cinebelUrl,
      cinebelUrl,
      showtimes,
    });
  }
  return films;
}
