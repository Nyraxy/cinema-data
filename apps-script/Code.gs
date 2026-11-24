/**
 * Daily cinema suggestions — Google Apps Script version.
 *
 * Reads the cinema + Letterboxd data that the GitHub Action publishes in this repo, checks your
 * Google Calendar, plans back-to-back cinema evenings and emails you (with posters) when there
 * are screenings you haven't been sent before. Runs in your own Google account: no other services.
 *
 * Setup: put Loader.gs (not this file) in a project at https://script.google.com and run install() once.
 * The loader fetches this file from GitHub on every run, so changes pushed here go live automatically.
 *   testRun()  sends a [TEST] email right away (ignores the "already sent" check).
 *   run()      what the triggers call (exactly 18:00, backup 19:00-20:00).
 *   reset()    forgets which screenings were sent.
 *
 * Wanted: Letterboxd watchlist, re-releases of films rated ★3.5+ or liked, and new films in a series
 * where you rated an earlier film ★3.5+ or liked it.
 * Calendar colours: Sage (2) = film ticket (that film is never suggested), Graphite (8) = ignored,
 * everything else is busy. Events marked "free" are ignored. Titles starting with "?" are placeholders:
 * not blocking, but a suggestion that overlaps one gets a note. Events with a location also block the
 * driving time between the cinema and that location (Google Maps, cached).
 */

const REPO_RAW = 'https://raw.githubusercontent.com/Nyraxy/cinema-data/main/';
const TZ = 'Europe/Brussels';
const RUN_AT = 18;     // email at exactly 18:00 (one-off trigger, re-booked every run)
const RETRY_UNTIL = 23;  // Mon/Tue: wait (retry every 30 min) until Pathé's new week is published, at most until 23:00
const BACKUP_HOUR = 19; // daily backup run between 19:00 and 20:00, only sends if the 18:00 run didn't
const GENT = ['sphinx-gent', 'studio-skoop-gent', 'kinepolis-gent'];
const SHORT = { 'pathe-sint-niklaas': 'Pathé', 'sphinx-gent': 'Sphinx Gent', 'studio-skoop-gent': 'Skoop Gent' };
const OFFICE_DAYS = [1, 2, 4]; // Mon, Tue, Thu (JS getUTCDay)
const MAX_POSTERS = 15;
const PREFIX = /^\s*(fan event|ladies night|family day|mini movie club|cine ?seniors|cin[eé] ?seniors|siniclub|cin[eé][ -]?club|film ?marathon|avant[ -]premi[eè]re|preview|sneak preview|re-?release|classics?|cult)\s*[:\-–]\s*/i;
const MIN = 60 * 1000;
const CINEMA_ADDR = { 'pathe-sint-niklaas': 'Pathé Sint-Niklaas, 9100 Sint-Niklaas, Belgium',
  'sphinx-gent': 'Sint-Michielshelling 3, 9000 Gent, Belgium', 'studio-skoop-gent': 'Sint-Annaplein 63, 9000 Gent, Belgium' };
const DRIVE_FAIL = new Set();
let DRIVE = null;

// driving minutes between a cinema and an event location (+10% margin), cached forever in script properties
function driveMin(cinema, loc) {
  loc = (loc || '').trim();
  if (!loc || !CINEMA_ADDR[cinema]) return 0;
  const props = PropertiesService.getScriptProperties();
  if (!DRIVE) DRIVE = JSON.parse(props.getProperty('drive') || '{}');
  const k = cinema + '|' + loc.toLowerCase();
  if (DRIVE_FAIL.has(loc)) return 0; // not saved: retried next run
  if (DRIVE[k] === undefined) {
    try {
      const r = Maps.newDirectionFinder().setOrigin(CINEMA_ADDR[cinema]).setDestination(loc)
        .setMode(Maps.DirectionFinder.Mode.DRIVING).getDirections();
      if (!r.routes || !r.routes.length) throw new Error(r.status || 'no route');
      DRIVE[k] = Math.ceil(r.routes[0].legs[0].duration.value / 60 * 1.1);
      props.setProperty('drive', JSON.stringify(DRIVE));
    } catch (e) { Logger.log('drive ' + loc + ': ' + e); DRIVE_FAIL.add(loc); return 0; }
  }
  return DRIVE[k];
}

// series detection: "Avengers: Doomsday" continues "The Avengers"; "Focker-in-Law" continues "Meet the Fockers"
const SERIES_PREFIX = /^\s*(fan event|ladies night|family day|cine ?seniors|cin[eé] ?seniors|siniclub|mini movie club|cin[eé][ -]?club|film ?marathon|avant[ -]premi[eè]re|preview|sneak preview|re-?release|classics?|cult)\s*[:\-–]\s*/i;
const COMMON = new Set(('about after again against alone always angel angels another back bad beast beauty before best big black blood blue body boys brother brothers ' +
  'children christmas city club cold dark daughter days dead death devil dream dreams earth every everything evil family father fire first friend friends ' +
  'game games ghost ghosts girl girls gold good great happy heart hearts heaven hell holiday home house hunter inside island jungle killer killers kings ' +
  'land last life light little lost love lovers magic master mother monster monsters money moon mountain murder music never night nights nothing ocean ' +
  'other others outside paradise party people perfect place power queen rain river road room school secret secrets sense shadow shadows silence sister ' +
  'sisters snow space spring star stars stone story stories street summer the their there things three time together tomorrow tonight town ' +
  'true truth under water wedding white wild winter woman women world young').split(' '));
function words(t) { return (t || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().match(/[a-z0-9]+/g) || []; }
function seriesName(t) {
  t = (t || '').replace(SERIES_PREFIX, '').replace(SUFFIX, '').split(/\s*[:–]\s|\s-\s/)[0];
  let w = words(t);
  while (w.length && ['the', 'a', 'an'].includes(w[0])) w = w.slice(1);
  while (w.length && (/^(\d+|[ivx]+)$/.test(w[w.length - 1]) || ['part', 'chapter', 'two', 'three', 'four', 'exclusieve'].includes(w[w.length - 1]))) w = w.slice(0, -1);
  return w;
}
function stemW(x) { return x.length > 4 && x.endsWith('s') ? x.slice(0, -1) : x; }
function seriesMatch(newTitle, likedTitle) {
  const s = seriesName(newTitle), ls = seriesName(likedTitle);
  if (!s.length || !ls.length) return false;
  if (ls.length <= s.length && ls.join(' ').length >= 4 && ls.every((x, i) => s[i] === x) && words(newTitle).join(' ') !== words(likedTitle).join(' ')) return true;
  const w = stemW(s[0]);
  return ls.length >= 2 && s[0].length >= 5 && !COMMON.has(s[0]) && !COMMON.has(w) && w === stemW(ls[ls.length - 1]);
}

// ---------- entry points ----------
function setup() {
  schedule_();
  Logger.log('Next run: %s:00 (backup between %s:00 and %s:00).', RUN_AT, BACKUP_HOUR, BACKUP_HOUR + 1);
}
// Brussels wall-clock time -> real Date
function brussels_(day, hour) {
  const off = Utilities.formatDate(new Date(day + 'T12:00:00Z'), TZ, 'XXX');
  return new Date(`${day}T${String(hour).padStart(2, '0')}:00:00${off}`);
}
function today18_() { return brussels_(Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'), RUN_AT).getTime(); }
// (re)book the next exact 18:00 run and the daily backup
function schedule_() {
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'run') ScriptApp.deleteTrigger(t); });
  let next = today18_();
  if (next < Date.now() + 10 * MIN) next = brussels_(Utilities.formatDate(new Date(Date.now() + 864e5), TZ, 'yyyy-MM-dd'), RUN_AT).getTime();
  ScriptApp.newTrigger('run').timeBased().at(new Date(next)).create();
  ScriptApp.newTrigger('run').timeBased().everyDays(1).atHour(BACKUP_HOUR).inTimezone(TZ).create();
}
function done_() { PropertiesService.getScriptProperties().setProperty('lastRun', String(Date.now())); }
function run() { main(false); }
function testRun() { main(true); }
function reset() { PropertiesService.getScriptProperties().deleteProperty('sent'); }

// ---------- time helpers: all times are "Brussels wall clock as UTC" milliseconds ----------
function parseLocal(s) { // "YYYY-MM-DD HH:MM"
  const m = s.match(/^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d)/);
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
}
function toLocal(date) { return parseLocal(Utilities.formatDate(date, TZ, 'yyyy-MM-dd HH:mm')); }
function fmt(ms, pattern) { return Utilities.formatDate(new Date(ms), 'UTC', pattern); }
function dow(ms) { return new Date(ms).getUTCDay(); }
function dayKey(ms) { return fmt(ms, 'yyyy-MM-dd'); }
function durTxt(m) { return m ? Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') : ''; }

// ---------- text helpers ----------
function norm(s) {
  s = (s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x00-\x7f]/g, '').toLowerCase();
  s = s.replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  return s.replace(/^(the|a|an|le|la|les|de|het) /, '');
}
const SUFFIX = /\s*[-–:]?\s*(exclusieve\s+)?(avant[ -]premi[eè]re|preview)\s*$/i;
function stripPrefix(t) { return (t || '').replace(PREFIX, '').replace(SUFFIX, '').trim(); }
function lbSplit(name) {
  const m = (name || '').match(/^(.*) \((\d{4})\)$/);
  return m ? [m[1], +m[2]] : [name, null];
}
function keyOf(title, cinema, time) { return norm(stripPrefix(title)) + '|' + cinema + '|' + time; }
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// ---------- inputs ----------
function fetchText(path) {
  const r = UrlFetchApp.fetch(REPO_RAW + path + '?t=' + Date.now(), { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error(path + ': HTTP ' + r.getResponseCode());
  return r.getContentText('UTF-8');
}

function readExcludes() {
  const names = [];
  try {
    fetchText('exclude.txt').split('\n').forEach(l => { l = l.trim(); if (l && !l.startsWith('#')) names.push(l); });
  } catch (e) { Logger.log('exclude.txt: ' + e); }
  // replies like "exclude: Film A, Film B" to a suggestions email
  GmailApp.search('in:sent subject:"Cinema suggestions" exclude', 0, 50).forEach(th => th.getMessages().forEach(m => {
    if (!/^re:/i.test(m.getSubject())) return;
    const first = m.getPlainBody().split('\n').map(l => l.trim()).find(l => l);
    const mm = first && first.match(/^exclude\s*:?\s*(.+)$/i);
    if (mm) mm[1].split(',').forEach(n => { n = n.trim(); if (n) names.push(n); });
  }));
  return names.map(n => { const [t, y] = lbSplit(n); return [norm(stripPrefix(t)), y]; });
}

function readSent(now) {
  const props = PropertiesService.getScriptProperties();
  let lines = JSON.parse(props.getProperty('sent') || 'null');
  if (!lines) { // first run: continue from the last email sent by the previous (Claude) version
    lines = [];
    const th = GmailApp.search('in:sent subject:"Cinema suggestions" -subject:Fwd -subject:Re', 0, 1)[0];
    if (th) {
      const body = th.getMessages().pop().getPlainBody();
      const idx = body.search(/^(SENT|SUGGESTIONS)\s*$/m);
      if (idx >= 0) body.slice(idx).split('\n').forEach(l => {
        const p = l.split('|').map(x => x.trim());
        if (p.length === 3 && /^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(p[2])) lines.push(p.join(' | '));
      });
    }
  }
  const nowStr = fmt(now, 'yyyy-MM-dd HH:mm');
  lines = lines.filter(l => l.split(' | ')[2] >= nowStr);
  const keys = new Set(lines.map(l => { const p = l.split(' | '); return keyOf(p[0], p[1], p[2]); }));
  return { lines, keys };
}

function readCalendar(from, to) {
  const busy = [], sage = [], holds = [];
  CalendarApp.getDefaultCalendar().getEvents(new Date(from - 3600000 * 2), new Date(to + 3600000 * 2)).forEach(ev => {
    try { if (ev.getTransparency && String(ev.getTransparency()) === 'TRANSPARENT') return; } catch (e) {}
    const color = String(ev.getColor() || '');
    if (color === '8') return;
    let s, e;
    if (ev.isAllDayEvent()) { s = toLocal(ev.getAllDayStartDate()); e = toLocal(ev.getAllDayEndDate()); }
    else { s = toLocal(ev.getStartTime()); e = toLocal(ev.getEndTime()); }
    const title = ev.getTitle() || '';
    if (title.trim().startsWith('?')) { holds.push({ s, e, title: title.trim().replace(/^\?\s*/, '') || 'placeholder' }); return; }
    let loc = ''; try { loc = ev.getLocation() || ''; } catch (x) {}
    busy.push({ s, e, title, loc });
  });
  // tickets: look wider than the planning range (far-ahead tickets, recently seen but not yet logged)
  CalendarApp.getDefaultCalendar().getEvents(new Date(from - 60 * 864e5), new Date(from + 365 * 864e5)).forEach(ev => {
    if (String(ev.getColor() || '') === '2') sage.push(norm(ev.getTitle()));
  });
  return { busy, sage, holds };
}

// ---------- planning ----------
function wantedFilms(data, excludes, now) {
  const year = new Date(now).getUTCFullYear();
  const lb = data.letterboxd;
  const watched = lb.watched || [];
  const watchedSlugs = new Set(watched.map(w => w.slug).filter(Boolean));
  const watchedKeys = new Set(watched.map(w => { const [t, y] = lbSplit(w.name); return norm(t) + '|' + y; }));
  const wl = {}, fav = {};
  (lb.watchlist || []).forEach(w => {
    const [t, y] = lbSplit(w.name);
    if (watchedSlugs.has(w.slug) || watchedKeys.has(norm(t) + '|' + y)) return;
    (wl[norm(t)] = wl[norm(t)] || []).push([t, y]);
  });
  watched.forEach(w => {
    const [t, y] = lbSplit(w.name);
    if (y && y <= year - 2 && ((w.rating || 0) >= 3.5 || w.liked)) (fav[norm(t)] = fav[norm(t)] || []).push([t, y, w.rating, w.liked]);
  });
  const watchedNames = new Set(watched.map(w => norm(lbSplit(w.name)[0])));
  const likedAll = [];
  watched.forEach(w => { const [t, y] = lbSplit(w.name); if (y && ((w.rating || 0) >= 3.5 || w.liked)) likedAll.push([t, y, w.rating, w.liked]); });
  likedAll.sort((a, b) => b[1] - a[1]); // mention the most recent film of the series
  const out = [];
  data.cinemas.forEach(c => (c.films || []).forEach(f => {
    const title = f.title || '';
    const special = PREFIX.test(title) || !!f.specialEvent || (f.showtimes || []).some(s => s.special);
    const names = [norm(stripPrefix(title)), norm(stripPrefix(f.originalTitle || ''))].filter(Boolean);
    if (names.some(n => excludes.some(([e]) => n === e))) return;
    const fy = f.year;
    let match = null;
    for (const n of names) {
      for (const [t, y] of wl[n] || []) {
        if (!fy || !y || Math.abs(fy - y) <= 1 || (special && y < fy)) { match = { kind: 'watchlist', lbName: y ? `${t} (${y})` : t }; break; }
      }
      if (match) break;
    }
    if (!match) for (const n of names) {
      for (const [t, y, rating, liked] of fav[n] || []) {
        if (special || (fy && Math.abs(fy - y) <= 1)) { match = { kind: 'rerelease', lbName: `${t} (${y})`, rating, liked }; break; }
      }
      if (match) break;
    }
    // new film in a series you liked (not a film you've already seen)
    if (!match && fy && fy >= year - 1 && !names.some(n => watchedNames.has(n))) {
      for (const [t, y, rating, liked] of likedAll) {
        if (y >= fy) continue;
        if ([title, f.originalTitle].some(x => x && seriesMatch(x, t))) { match = { kind: 'series', lbName: `${stripPrefix(title)}`, prev: `${t} (${y})`, rating, liked }; break; }
      }
    }
    if (!match) return;
    const display = lbSplit(match.lbName)[0];
    out.push(Object.assign(match, { film: f, cinema: c.key, cinemaName: c.name || c.key, norm: norm(match.lbName),
      display, names: names.concat([norm(display)]) }));
  }));
  return out;
}

function allScreenings(wf, now) {
  const out = [], dubbed = new Set();
  wf.forEach(w => {
    const f = w.film, dur = f.duration || 120, gent = GENT.includes(w.cinema);
    (f.showtimes || []).forEach(s => {
      const t = parseLocal(s.time);
      if (t < now + 45 * MIN) return;
      if (!String(s.version || '').toLowerCase().startsWith('vo')) { dubbed.add(w); return; }
      const d = dow(t), mins = Number(s.time.slice(11, 13)) * 60 + Number(s.time.slice(14, 16));
      let ok = false;
      if (OFFICE_DAYS.includes(d)) ok = mins >= (gent ? 17 * 60 : 16 * 60);
      else if (d === 0 || d === 6) ok = true;
      out.push({ w, t, time: s.time, dur, gent, ok, key: keyOf(w.display, w.cinema, s.time) });
    });
  });
  return { scs: out, dubbed };
}

function windowOf(s) { const travel = s.gent ? 45 : 30; return [s.t - travel * MIN, s.t + (15 + s.dur + 15) * MIN]; }
// a..b = the screening's window (travel from home, film, 15 min to leave); events with a location
// also need the drive between the cinema and that place before/after them
function clash(a, b, busy, cinema) {
  for (const ev of busy) {
    const d = cinema && ev.loc ? driveMin(cinema, ev.loc) * MIN : 0;
    if (ev.s - d < b && ev.e + d > a) return (ev.title || 'busy') + (d >= 30 * MIN ? ` (${durTxt(d / MIN)} drive)` : '');
  }
  return null;
}
function hasTicket(w, sage) {
  return sage.some(ev => w.names.some(n => n.length >= 3 &&
    (new RegExp('\\b' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(ev) || (ev.length >= 3 && n.includes(ev)))));
}

function bestChain(scs) {
  scs = scs.slice().sort((a, b) => a.t - b.t);
  let best = null, bestScore = null;
  function better(sc) { if (!bestScore) return true; for (let i = 0; i < 3; i++) { if (sc[i] !== bestScore[i]) return sc[i] > bestScore[i]; } return false; }
  function dfs(chain, used, wait) {
    if (chain.length) { const sc = [chain.length, -wait, -chain[0].t]; if (better(sc)) { bestScore = sc; best = chain.slice(); } }
    const last = chain[chain.length - 1];
    for (const s of scs) {
      if (used.has(s.w.norm)) continue;
      let gap = 0;
      if (last) {
        if (s.t <= last.t || s.t < last.t + (last.dur - 5) * MIN) continue;
        gap = Math.max(0, Math.floor((s.t - (last.t + last.dur * MIN)) / MIN));
      }
      chain.push(s); used.add(s.w.norm);
      dfs(chain, used, wait + gap);
      chain.pop(); used.delete(s.w.norm);
    }
  }
  dfs([], new Set(), 0);
  return best || [];
}

function plan(scs, busy) {
  const fit = scs.filter(s => { if (!s.ok) return false; const [a, b] = windowOf(s); return !clash(a, b, busy, s.w.cinema); });
  const groups = {};
  fit.forEach(s => { const k = dayKey(s.t) + '|' + s.w.cinema; (groups[k] = groups[k] || []).push(s); });
  const chainOk = ch => !clash(windowOf(ch[0])[0], windowOf(ch[ch.length - 1])[1], busy, ch[0].w.cinema);
  const isWeekday = k => { const d = dow(parseLocal(k.split('|')[0] + ' 12:00')); return d >= 1 && d <= 5; };
  const isGent = k => GENT.includes(k.split('|')[1]);
  const tiers = [k => !isGent(k) && isWeekday(k), k => !isGent(k) && !isWeekday(k), k => isGent(k) && isWeekday(k), k => isGent(k) && !isWeekday(k)];
  const covered = new Set(), days = [], usedGroups = new Set();
  tiers.forEach(tier => {
    for (;;) {
      let pick = null, pickScore = null;
      Object.keys(groups).forEach(k => {
        if (!tier(k) || usedGroups.has(k)) return;
        let pool = groups[k].filter(s => !covered.has(s.w.norm));
        let ch = bestChain(pool);
        while (ch.length && !chainOk(ch)) { const lastS = ch[ch.length - 1]; pool = pool.filter(s => s !== lastS); ch = bestChain(pool); }
        if (!ch.length) return;
        let wait = 0; for (let i = 1; i < ch.length; i++) wait += Math.max(0, (ch[i].t - ch[i - 1].t) / MIN - ch[i - 1].dur);
        const d = dow(ch[0].t);
        const score = [ch.length, -wait, d === 1 ? 1 : 0, -ch[0].t];
        let isBetter = !pickScore;
        if (pickScore) for (let i = 0; i < score.length; i++) { if (score[i] !== pickScore[i]) { isBetter = score[i] > pickScore[i]; break; } }
        if (isBetter) { pick = { k, ch }; pickScore = score; }
      });
      if (!pick) break;
      usedGroups.add(pick.k);
      days.push({ date: pick.ch[0].t, cinema: pick.k.split('|')[1], chain: pick.ch });
      pick.ch.forEach(s => covered.add(s.w.norm));
    }
  });
  days.sort((a, b) => (GENT.includes(a.cinema) - GENT.includes(b.cinema)) || (a.date - b.date));
  const chosen = new Set(days.flatMap(x => x.chain.map(s => s.key)));
  const also = {};
  fit.slice().sort((a, b) => (a.gent - b.gent) || (a.t - b.t)).forEach(s => {
    const n = s.w.norm;
    if (covered.has(n) && !chosen.has(s.key) && (also[n] || []).length < 3) (also[n] = also[n] || []).push(s);
  });
  return { days, also, covered };
}

// ---------- email ----------
function badge(text, color, extra) {
  return `<span style="background-color:${color};color:#ffffff;border-radius:4px;padding:1px 6px;font-size:11px;font-weight:bold${extra || ''}">${esc(text)}</span>`;
}

function render(now, days, also, others, sentKeys, test, posterCid, warnings, holds) {
  const holdOf = s => { const [a, b] = windowOf(s); return clash(a, b, holds || []); };
  const nFilms = days.reduce((n, x) => n + x.chain.length, 0);
  const o = [];
  o.push('<div style="background-color:#f3f4f6;padding:12px 0;font-family:Arial,Helvetica,sans-serif;color:#111827">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="max-width:600px;margin:0 auto;background-color:#ffffff;border-radius:12px">');
  o.push(`<tr><td bgcolor="#111827" style="background-color:#111827;color:#ffffff;padding:16px 20px;border-radius:12px 12px 0 0">` +
    `<div style="font-size:20px;font-weight:bold">&#127916; Cinema suggestions${test ? ' ' + badge('TEST', '#6b7280') : ''}</div>` +
    `<div style="font-size:13px;color:#d1d5db;margin-top:4px">${fmt(now, 'EEEE d MMMM')} · ${nFilms} film${nFilms === 1 ? '' : 's'} across ${days.length} cinema day${days.length === 1 ? '' : 's'}</div></td></tr>`);
  if (warnings.length) o.push(`<tr><td bgcolor="#fff7ed" style="background-color:#fff7ed;color:#9a3412;padding:8px 20px;font-size:13px">&#9888;&#65039; ${esc(warnings.join(' · '))}</td></tr>`);
  o.push('<tr><td style="padding:14px 20px 4px"><div style="font-size:12px;font-weight:bold;color:#6b7280;text-transform:uppercase;margin-bottom:6px">Overview</div><table width="100%" cellpadding="0" cellspacing="0">');
  days.forEach(x => {
    const gent = GENT.includes(x.cinema);
    const [bg, fg] = gent ? ['#e6f7f4', '#0b6b5e'] : ['#eef2ff', '#3730a3'];
    const chips = x.chain.map(s => `<span style="display:inline-block;background-color:${bg};color:${fg};border-radius:999px;padding:3px 9px;font-size:12px;margin:0 4px 4px 0">${fmt(s.t, 'HH:mm')} ${esc(s.w.display)}</span>`).join('');
    o.push(`<tr><td width="120" style="padding:5px 0;font-size:13px;font-weight:bold;vertical-align:top">${fmt(x.date, 'EEE d MMM')}<br><span style="font-weight:normal;color:#6b7280;font-size:12px">${esc(SHORT[x.cinema] || x.cinema)}</span></td><td style="padding:5px 0;vertical-align:top">${chips}</td></tr>`);
  });
  o.push('</table></td></tr>');
  days.forEach(x => {
    const gent = GENT.includes(x.cinema), ch = x.chain, last = ch[ch.length - 1];
    const home = last.t + (15 + last.dur + (gent ? 20 : 30)) * MIN;
    const d = dow(x.date);
    const tags = (d === 0 || d === 6 ? badge('WEEKEND', '#f76b15', ';margin-left:6px') : '') + (gent ? badge('GENT', '#12a594', ';margin-left:6px') : '');
    o.push(`<tr><td style="padding:12px 20px 0"><table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:10px">` +
      `<tr><td colspan="3" bgcolor="#f9fafb" style="background-color:#f9fafb;padding:9px 12px;border-bottom:1px solid #e5e7eb;border-radius:10px 10px 0 0">` +
      `<b style="font-size:15px">${fmt(x.date, 'EEEE d MMMM')}</b><span style="font-size:13px;color:#6b7280"> · ${esc(ch[0].w.cinemaName)} · ${ch.length} film${ch.length === 1 ? '' : 's'} · home ~${fmt(home, 'HH:mm')}</span>${tags}</td></tr>`);
    ch.forEach((s, i) => {
      if (i) {
        const prev = ch[i - 1], wait = Math.floor((s.t - prev.t) / MIN) - prev.dur;
        if (wait > 30) o.push(`<tr><td colspan="3" style="padding:0 12px"><div style="border-top:1px dashed #e5e7eb;font-size:11px;color:#9ca3af;padding:3px 0 0 52px">${wait >= 60 ? durTxt(wait) : wait + ' min'} wait</div></td></tr>`);
      }
      const f = s.w.film, w = s.w, end = s.t + (15 + s.dur) * MIN;
      const cid = posterCid[f.posterThumb];
      const img = cid ? `<img src="cid:${cid}" width="54" height="80" alt="" style="display:block;border-radius:4px">`
        : '<div style="width:54px;height:80px;border-radius:4px;background-color:#e5e7eb"></div>';
      const meta = [f.year || '', durTxt(f.duration), (f.directors || []).join(', ')].filter(Boolean).join(' · ');
      const kb = w.kind === 'watchlist' ? badge('Watchlist', '#3e63dd')
        : w.kind === 'series' ? badge(`Series · you ${w.liked ? '♥ liked' : 'rated ★' + w.rating} ${w.prev}`, '#d6409f')
        : badge(w.rating ? `Re-release · you rated ★${w.rating}` : 'Re-release · ♥ liked', '#8e4ec6');
      const isNew = !test && !sentKeys.has(s.key);
      const al = also[w.norm] || [];
      const alsoTxt = al.length ? `<div style="font-size:12px;color:#6b7280;margin-top:5px">Also: ${esc(al.map(a =>
        fmt(a.t, 'EEE d HH:mm') + (a.w.cinema === w.cinema ? '' : ` (${SHORT[a.w.cinema] || ''})`) + (!test && !sentKeys.has(a.key) ? ' new' : '') + (holdOf(a) ? ' (placeholder)' : '')).join(' · '))}</div>` : '';
      const hold = holdOf(s);
      const holdTxt = hold ? `<div style="font-size:12px;color:#9a3412;background-color:#fff7ed;border-radius:4px;padding:3px 6px;margin-top:5px;display:inline-block">&#9888;&#65039; Overlaps placeholder “?${esc(hold)}”</div>` : '';
      o.push(`<tr><td width="58" style="padding:9px 0 9px 12px;vertical-align:top;text-align:center"><div style="font-size:16px;font-weight:bold">${fmt(s.t, 'HH:mm')}</div>` +
        `<div style="font-size:11px;color:#6b7280">until ~${fmt(end, 'HH:mm')}</div></td><td width="62" style="padding:9px 8px;vertical-align:top">${img}</td>` +
        `<td style="padding:9px 12px 9px 0;vertical-align:top"><a href="${esc(f.url || f.cinebelUrl || '#')}" style="font-size:15px;font-weight:bold;color:#111827;text-decoration:none">${esc(w.display)}</a>` +
        `${isNew ? badge('NEW', '#e5484d', ';margin-left:4px') : ''}<div style="font-size:12px;color:#6b7280;margin-top:3px">${esc(meta)}</div><div style="margin-top:5px">${kb}</div>${holdTxt}${alsoTxt}</td></tr>`);
    });
    o.push('</table></td></tr>');
  });
  if (others.length) {
    o.push('<tr><td style="padding:14px 20px 0"><div style="font-size:12px;font-weight:bold;color:#6b7280;text-transform:uppercase;margin-bottom:4px">Other options</div>');
    others.forEach(([t, why]) => o.push(`<div style="font-size:13px;padding:4px 0;border-bottom:1px solid #f3f4f6"><b>${esc(t)}</b> <span style="color:#6b7280">· ${esc(why)}</span></div>`));
    o.push('</td></tr>');
  }
  o.push('<tr><td style="padding:14px 20px 16px;font-size:11px;color:#9ca3af">Don\'t want a film suggested? Reply "exclude: &lt;title&gt;" or add it to exclude.txt in the cinema-data repo.</td></tr></table></div>');
  return o.join('');
}

// short "it ran, nothing new" email so you know the automation works
function noNews(now, data, wf, scs, sent, warnings, reason) {
  const films = new Set(wf.map(w => w.norm)).size;
  const updated = Utilities.formatDate(new Date(data.generatedAt), TZ, 'EEE d MMM HH:mm');
  const html = '<div style="background-color:#f3f4f6;padding:12px 0;font-family:Arial,Helvetica,sans-serif;color:#111827">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="max-width:600px;margin:0 auto;background-color:#ffffff;border-radius:12px">' +
    `<tr><td bgcolor="#111827" style="background-color:#111827;color:#ffffff;padding:16px 20px;border-radius:12px 12px 0 0"><div style="font-size:20px;font-weight:bold">&#127916; No new suggestions</div>` +
    `<div style="font-size:13px;color:#d1d5db;margin-top:4px">${fmt(now, 'EEEE d MMMM')}</div></td></tr>` +
    (warnings.length ? `<tr><td bgcolor="#fff7ed" style="background-color:#fff7ed;color:#9a3412;padding:8px 20px;font-size:13px">&#9888;&#65039; ${esc(warnings.join(' · '))}</td></tr>` : '') +
    `<tr><td style="padding:14px 20px 16px;font-size:14px;line-height:1.5">${esc(reason)}<br><span style="color:#6b7280;font-size:13px">Checked ${films} wanted film${films === 1 ? '' : 's'} and ${scs.length} screening${scs.length === 1 ? '' : 's'} · cinema data from ${esc(updated)}. Earlier suggestions still stand.</span></td></tr></table></div>`;
  MailApp.sendEmail(Session.getEffectiveUser().getEmail(), `🎬 Cinema suggestions – ${fmt(now, 'EEEE d MMMM')}: nothing new`,
    [reason, `Checked ${films} films, ${scs.length} screenings. Cinema data from ${updated}.`].concat(warnings).concat(['', 'SENT']).concat(sent.lines).join('\n'),
    { htmlBody: html, name: 'Cinema suggestions' });
  PropertiesService.getScriptProperties().setProperty('sent', JSON.stringify(sent.lines));
  done_();
  Logger.log('No news: ' + reason);
}

// ---------- main ----------
function main(test) {
  if (!test) {
    schedule_();
    const last = Number(PropertiesService.getScriptProperties().getProperty('lastRun') || 0);
    if (last >= today18_() && Date.now() >= today18_()) { Logger.log('Already sent today after 18:00.'); return; }
  }
  const now = toLocal(new Date());
  const data = JSON.parse(fetchText('data/cinema.json'));
  const warnings = [];
  const age = Date.now() - new Date(data.generatedAt).getTime();
  if (age > 24 * 3600000) warnings.push(`cinema data is ${Math.round(age / 3600000)}h old`);
  data.cinemas.forEach(c => { if (c.state === 'stale' || c.state === 'missing') warnings.push(`${c.name || c.key} data is ${c.state}`); });

  // Pathé publishes the next week (Wed-Tue) on Monday evening, sometimes late: on Mon/Tue wait for it
  const wd = dow(now);
  if (wd === 1 || wd === 2) {
    const wed = dayKey(now + (wd === 1 ? 2 : 1) * 864e5);
    const pathe = data.cinemas.find(c => c.key === 'pathe-sint-niklaas') || { films: [] };
    const n = pathe.films.reduce((k, f) => k + (f.showtimes || []).filter(s => s.time.startsWith(wed)).length, 0);
    if (n < 10) {
      if (!test && Number(fmt(now, 'HH')) < RETRY_UNTIL) {
        ScriptApp.newTrigger('run').timeBased().after(30 * MIN).create();
        Logger.log(`Pathé schedule for ${wed} not published yet (${n} showtimes): retrying in 30 min.`);
        return;
      }
      warnings.push(`Pathé hasn't published the schedule from ${fmt(parseLocal(wed + ' 12:00'), 'EEEE d MMMM')} yet`);
    }
  }

  const sent = readSent(now);
  const wf = wantedFilms(data, readExcludes(), now);
  let { scs, dubbed } = allScreenings(wf, now);

  const unsent = scs.filter(s => s.ok && !sent.keys.has(s.key));
  if (!unsent.length && !test) return noNews(now, data, wf, scs, sent, warnings, 'No new screenings of your films since the last email.');

  const last = scs.reduce((m, s) => Math.max(m, s.t), now) + 24 * 3600000;
  const fixedCal = readCalendar(now, last);
  const ticket = new Set(wf.filter(w => hasTicket(w, fixedCal.sage)).map(w => w.norm));
  scs = scs.filter(s => !ticket.has(s.w.norm));
  const { days, also, covered } = plan(scs, fixedCal.busy);

  // other options
  const others = [], seen = new Set([...covered, ...ticket]);
  scs.slice().sort((a, b) => (a.gent - b.gent) || (a.t - b.t)).forEach(s => {
    const n = s.w.norm;
    if (seen.has(n)) return;
    seen.add(n);
    const mine = scs.filter(x => x.w.norm === n), okT = mine.filter(x => x.ok);
    let why;
    if (okT.length) { const [a, b] = windowOf(okT[0]); why = `${fmt(okT[0].t, 'EEE d HH:mm')} (${SHORT[okT[0].w.cinema] || ''}) clashes with “${clash(a, b, fixedCal.busy, okT[0].w.cinema)}”`; }
    else why = 'only during work hours: ' + mine.slice(0, 2).map(x => fmt(x.t, 'EEE d HH:mm')).join(', ');
    others.push([s.w.display, why]);
  });
  wf.forEach(w => { if (dubbed.has(w) && !seen.has(w.norm)) { seen.add(w.norm); others.push([w.display, `only dubbed at ${SHORT[w.cinema] || w.cinema}`]); } });

  const shown = days.flatMap(x => x.chain).concat(Object.values(also).flat());
  const fresh = shown.filter(s => !sent.keys.has(s.key));
  if (!fresh.length && !test) return noNews(now, data, wf, scs, sent, warnings, 'No new screenings that fit your calendar since the last email.');

  // posters
  const inlineImages = {}, posterCid = {};
  days.flatMap(x => x.chain).forEach(s => {
    const rel = s.w.film.posterThumb;
    if (!rel || posterCid[rel] || Object.keys(inlineImages).length >= MAX_POSTERS) return;
    try {
      const r = UrlFetchApp.fetch(REPO_RAW + rel, { muteHttpExceptions: true });
      if (r.getResponseCode() !== 200) return;
      const id = 'p' + Object.keys(inlineImages).length;
      inlineImages[id] = r.getBlob().setName(id + '.jpg');
      posterCid[rel] = id;
    } catch (e) { Logger.log('poster ' + rel + ': ' + e); }
  });

  if (DRIVE_FAIL.size) warnings.push('couldn\'t find a route to ' + [...DRIVE_FAIL].map(l => '“' + l + '”').join(', ') + ' (driving time ignored)');
  const html = render(now, days, also, others.slice(0, 10), sent.keys, test, posterCid, warnings, fixedCal.holds);
  const text = ['Cinema suggestions, ' + fmt(now, 'EEE d MMM') + ':']
    .concat(days.map(x => `${fmt(x.date, 'EEE d MMM')} (${SHORT[x.cinema] || x.cinema}): ` + x.chain.map(s => { const [a, b] = windowOf(s), h = clash(a, b, fixedCal.holds); return `${fmt(s.t, 'HH:mm')} ${s.w.display}` + (h ? ` [overlaps placeholder ?${h}]` : ''); }).join(', ')));

  // remember what was shown (future screenings only)
  const keep = {};
  sent.lines.forEach(l => { const p = l.split(' | '); keep[keyOf(p[0], p[1], p[2])] = l; });
  shown.forEach(s => { keep[s.key] = `${s.w.display} | ${s.w.cinema} | ${s.time}`; });
  const lines = Object.values(keep).sort((a, b) => a.split(' | ')[2].localeCompare(b.split(' | ')[2]));

  const to = Session.getEffectiveUser().getEmail();
  // MailApp (not GmailApp): GmailApp garbles emoji in the subject
  MailApp.sendEmail(to, `${test ? '[TEST] ' : ''}\uD83C\uDFAC Cinema suggestions \u2013 ${fmt(now, 'EEEE d MMMM')}`,
    text.concat(['', 'SENT']).concat(lines).join('\n'), { htmlBody: html, inlineImages, name: 'Cinema suggestions' });
  if (!test) { PropertiesService.getScriptProperties().setProperty('sent', JSON.stringify(lines)); done_(); }
  Logger.log(`Sent: ${days.length} days, ${fresh.length} new screenings, ${Object.keys(inlineImages).length} posters.`);
}
