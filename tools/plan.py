#!/usr/bin/env python3
"""Cinema planner: does all the deterministic work for the daily suggestions email.

  python3 -I tools/plan.py prepare [--sent sent.txt] [--exclude "Title" ...]
      -> JSON: candidate screenings that were never sent, and the calendar range to fetch.
         If "unsent" is 0, nothing new is possible: stop without fetching the calendar.

  python3 -I tools/plan.py build --calendar cal.txt [--sent sent.txt] [--exclude "Title" ...] [--test]
      -> writes out/email.html, out/body.txt, out/attachments.json and prints a JSON report
         ({"new": N, "subject": ..., ...}). Send only if new > 0 (or --test).

sent.txt   : the "SENT" lines from the plain-text body of the latest suggestions email
             ("film | cinema-key | YYYY-MM-DD HH:MM"); missing/empty = nothing sent yet.
cal.txt    : one calendar event per line: start|end|colorId|title
             start/end as returned by Google Calendar (dateTime with offset, or a date for all-day
             events); colorId empty for the default colour. Leave out free/transparent events.
"""
import argparse
import datetime as dt
import base64
import html
import json
import os
import re
import sys
import unicodedata
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Europe/Brussels")
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(REPO, "out")
GENT_KEYS = {"sphinx-gent", "studio-skoop-gent", "kinepolis-gent"}
SHORT = {"pathe-sint-niklaas": "Pathé", "sphinx-gent": "Sphinx Gent", "studio-skoop-gent": "Skoop Gent"}
TRAVEL = {"pathe": 30, "gent": 45}
OFFICE_DAYS = {0, 1, 3}  # Mon, Tue, Thu
PREFIX = re.compile(
    r"^\s*(fan event|cine ?seniors|cin[eé] ?seniors|siniclub|cin[eé][ -]?club|film ?marathon|avant[ -]premi[eè]re|"
    r"preview|sneak preview|re-?release|classics?|cult)\s*[:\-–]\s*",
    re.I,
)
MAX_POSTERS = 12
NOW = dt.datetime.now(TZ).replace(tzinfo=None)


# ---------- helpers ----------
def norm(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    s = s.replace("&", " and ")
    s = re.sub(r"[^a-z0-9]+", " ", s).strip()
    s = re.sub(r"^(the|a|an|le|la|les|de|het) ", "", s)
    return s


def strip_prefix(t):
    return PREFIX.sub("", t or "").strip()


def lb_split(name):
    m = re.match(r"^(.*) \((\d{4})\)$", name or "")
    return (m.group(1), int(m.group(2))) if m else (name, None)


def parse_dt(s):
    s = s.strip()
    if len(s) == 10:
        return dt.datetime.fromisoformat(s), True
    d = dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    if d.tzinfo:
        d = d.astimezone(TZ).replace(tzinfo=None)
    return d, False


def fmt_dur(m):
    return f"{m // 60}h{m % 60:02d}" if m else ""


def day_label(d, long=False):
    return d.strftime("%A %-d %B") if long else d.strftime("%a %-d %b")


def key_of(title, cinema, t):
    return f"{norm(strip_prefix(title))}|{cinema}|{t}"


def read_sent(path):
    keys, lines = set(), []
    if path and os.path.exists(path):
        for line in open(path, encoding="utf-8"):
            parts = [p.strip() for p in line.split("|")]
            if len(parts) == 3 and re.match(r"\d{4}-\d\d-\d\d \d\d:\d\d", parts[2]):
                keys.add(key_of(parts[0], parts[1], parts[2]))
                lines.append(parts)
    return keys, lines


def read_excludes(extra):
    names = list(extra or [])
    p = os.path.join(REPO, "exclude.txt")
    if os.path.exists(p):
        names += [l.strip() for l in open(p, encoding="utf-8") if l.strip() and not l.lstrip().startswith("#")]
    out = []
    for n in names:
        t, y = lb_split(n)
        out.append((norm(strip_prefix(t)), y))
    return out


# ---------- wanted films ----------
def load():
    return json.load(open(os.path.join(REPO, "data", "cinema.json"), encoding="utf-8"))


def wanted_films(data, excludes):
    lb = data["letterboxd"]
    watched = lb.get("watched") or []
    watched_slugs = {w.get("slug") for w in watched if w.get("slug")}
    watched_keys = {(norm(lb_split(w["name"])[0]), lb_split(w["name"])[1]) for w in watched}
    wl = {}
    for w in lb.get("watchlist") or []:
        t, y = lb_split(w["name"])
        if w.get("slug") in watched_slugs or (norm(t), y) in watched_keys:
            continue
        wl.setdefault(norm(t), []).append((t, y, w.get("slug")))
    fav = {}
    for w in watched:
        t, y = lb_split(w["name"])
        if y and y <= NOW.year - 2 and ((w.get("rating") or 0) >= 3.5 or w.get("liked")):
            fav.setdefault(norm(t), []).append((t, y, w.get("rating"), w.get("liked")))

    films = []
    for c in data["cinemas"]:
        for f in c.get("films") or []:
            title = f.get("title") or ""
            special = bool(PREFIX.match(title)) or bool(f.get("specialEvent")) or any(
                s.get("special") for s in f.get("showtimes") or []
            )
            names = {norm(strip_prefix(title)), norm(strip_prefix(f.get("originalTitle") or ""))} - {""}
            if any(n == e or (y and n == e) for n in names for e, y in excludes):
                continue
            fy = f.get("year")
            match = None
            for n in names:
                for t, y, slug in wl.get(n, []):
                    if fy is None or y is None or abs(fy - y) <= 1 or (special and y < fy):
                        match = {"kind": "watchlist", "lbName": f"{t} ({y})" if y else t}
                        break
                if match:
                    break
            if not match:
                for n in names:
                    for t, y, rating, liked in fav.get(n, []):
                        if special or (fy and abs(fy - y) <= 1):
                            match = {"kind": "rerelease", "lbName": f"{t} ({y})", "rating": rating, "liked": liked}
                            break
                    if match:
                        break
            if match:
                disp = lb_split(match["lbName"])[0]
                films.append({**match, "film": f, "cinema": c["key"], "cinemaName": c.get("name") or c["key"],
                              "norm": norm(match["lbName"]), "display": disp, "names": names | {norm(disp)}})
    return films


def screenings(wf):
    """All future original-version screenings of wanted films, with time-of-day eligibility."""
    out, dubbed = [], set()
    for w in wf:
        f = w["film"]
        dur = f.get("duration") or 120
        gent = w["cinema"] in GENT_KEYS
        for s in f.get("showtimes") or []:
            t = dt.datetime.strptime(s["time"], "%Y-%m-%d %H:%M")
            if t < NOW + dt.timedelta(minutes=45):
                continue
            if not (s.get("version") or "").lower().startswith("vo"):
                dubbed.add(id(w))
                continue
            wd = t.weekday()
            if wd in OFFICE_DAYS:
                ok = t.hour * 60 + t.minute >= (17 * 60 if gent else 16 * 60)
                weekend = False
            elif wd >= 5:
                ok, weekend = True, True
            else:
                ok, weekend = False, False
            out.append({"w": w, "t": t, "time": s["time"], "dur": dur, "gent": gent, "ok": ok, "weekend": weekend,
                        "key": key_of(w["display"], w["cinema"], s["time"])})
    return out, dubbed


# ---------- calendar ----------
def read_calendar(path):
    busy, sage = [], []
    for line in open(path, encoding="utf-8"):
        parts = line.rstrip("\n").split("|")
        if len(parts) < 3 or not parts[0].strip():
            continue
        try:
            s, allday = parse_dt(parts[0])
            e, _ = parse_dt(parts[1])
        except ValueError:
            continue
        color = parts[2].strip()
        title = "|".join(parts[3:]).strip()
        if color == "8":
            continue
        busy.append((s, e, title))
        if color == "2":
            sage.append(norm(title))
    return busy, sage


def has_ticket(w, sage):
    for ev in sage:
        for n in w["names"]:
            if len(n) >= 3 and (re.search(rf"\b{re.escape(n)}\b", ev) or (len(ev) >= 3 and ev in n)):
                return True
    return False


def clash(start, end, busy):
    for s, e, title in busy:
        if s < end and e > start:
            return title or "busy"
    return None


def window(sc):
    travel = TRAVEL["gent" if sc["gent"] else "pathe"]
    return sc["t"] - dt.timedelta(minutes=travel), sc["t"] + dt.timedelta(minutes=15 + sc["dur"] + 15)


# ---------- chains ----------
def best_chain(scs):
    """Most films, then least waiting, then earliest start. scs: same day + same cinema."""
    scs = sorted(scs, key=lambda s: s["t"])
    best = (0, 0, None, [])

    def dfs(chain, used, wait):
        nonlocal best
        score = (len(chain), -wait, -(chain[0]["t"].timestamp()) if chain else 0)
        if chain and score > best[:3]:
            best = (*score, list(chain))
        last = chain[-1] if chain else None
        for s in scs:
            if s["w"]["norm"] in used:
                continue
            if last:
                earliest = last["t"] + dt.timedelta(minutes=last["dur"] - 5)
                if s["t"] < earliest or s["t"] <= last["t"]:
                    continue
                gap = max(0, int((s["t"] - (last["t"] + dt.timedelta(minutes=last["dur"]))).total_seconds() // 60))
            else:
                gap = 0
            chain.append(s)
            used.add(s["w"]["norm"])
            dfs(chain, used, wait + gap)
            chain.pop()
            used.discard(s["w"]["norm"])

    dfs([], set(), 0)
    return best[3]


def plan(scs, busy):
    fit = []
    for s in scs:
        if not s["ok"]:
            continue
        a, b = window(s)
        if busy is not None and clash(a, b, busy):
            continue
        fit.append(s)
    groups = {}
    for s in fit:
        groups.setdefault((s["t"].date(), s["w"]["cinema"]), []).append(s)

    def chain_ok(ch):
        if busy is None:
            return True
        a, _ = window(ch[0])
        _, b = window(ch[-1])
        return clash(a, b, busy) is None

    tiers = [
        lambda d, c: c not in GENT_KEYS and d.weekday() < 5,
        lambda d, c: c not in GENT_KEYS and d.weekday() >= 5,
        lambda d, c: c in GENT_KEYS and d.weekday() < 5,
        lambda d, c: c in GENT_KEYS and d.weekday() >= 5,
    ]
    covered, days = set(), []
    for tier in tiers:
        while True:
            cands = []
            for (d, c), g in groups.items():
                if not tier(d, c) or any(x["date"] == d and x["cinema"] == c for x in days):
                    continue
                pool = [s for s in g if s["w"]["norm"] not in covered]
                ch = best_chain(pool)
                while ch and not chain_ok(ch):  # fall back to shorter chains if the whole span clashes
                    pool = [s for s in pool if s is not ch[-1]]
                    ch = best_chain(pool)
                if ch:
                    wait = sum(max(0, (b["t"] - a["t"]).total_seconds() / 60 - a["dur"]) for a, b in zip(ch, ch[1:]))
                    cands.append(((len(ch), -wait, d.weekday() == 0, -d.toordinal(), -ch[0]["t"].hour), d, c, ch))
            if not cands:
                break
            _, d, c, ch = max(cands, key=lambda x: x[0])
            days.append({"date": d, "cinema": c, "chain": ch})
            covered |= {s["w"]["norm"] for s in ch}
    # Pathé first, then Gent; each by date
    days.sort(key=lambda x: (x["cinema"] in GENT_KEYS, x["date"], x["chain"][0]["t"]))
    chosen_keys = {s["key"] for x in days for s in x["chain"]}
    also = {}
    for s in sorted(fit, key=lambda s: (s["gent"], s["t"])):
        n = s["w"]["norm"]
        if n in covered and s["key"] not in chosen_keys and len(also.get(n, [])) < 3:
            also.setdefault(n, []).append(s)
    return days, also, covered, fit


# ---------- email ----------
BADGE = "color:#ffffff;border-radius:4px;padding:1px 6px;font-size:11px;font-weight:bold"


def badge(text, color, extra=""):
    return f'<span style="background-color:{color};{BADGE}{extra}">{html.escape(text)}</span>'


def render(days, also, others, sent_keys, test, poster_cid):
    n_films = sum(len(x["chain"]) for x in days)
    e = html.escape
    o = []
    o.append('<div style="background-color:#f3f4f6;padding:12px 0;font-family:Arial,Helvetica,sans-serif;color:#111827">'
             '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#ffffff" '
             'style="max-width:600px;margin:0 auto;background-color:#ffffff;border-radius:12px">')
    o.append(f'<tr><td bgcolor="#111827" style="background-color:#111827;color:#ffffff;padding:16px 20px;border-radius:12px 12px 0 0">'
             f'<div style="font-size:20px;font-weight:bold">🎬 Cinema suggestions{" " + badge("TEST", "#6b7280") if test else ""}</div>'
             f'<div style="font-size:13px;color:#d1d5db;margin-top:4px">{e(day_label(NOW, True))} · {n_films} film{"s" * (n_films != 1)} '
             f'across {len(days)} cinema day{"s" * (len(days) != 1)}</div></td></tr>')
    if WARNINGS:
        o.append(f'<tr><td bgcolor="#fff7ed" style="background-color:#fff7ed;color:#9a3412;padding:8px 20px;font-size:13px">⚠️ {e(" · ".join(WARNINGS))}</td></tr>')
    # overview
    o.append('<tr><td style="padding:14px 20px 4px"><div style="font-size:12px;font-weight:bold;color:#6b7280;'
             'text-transform:uppercase;margin-bottom:6px">Overview</div><table width="100%" cellpadding="0" cellspacing="0">')
    for x in days:
        gent = x["cinema"] in GENT_KEYS
        bg, fg = ("#e6f7f4", "#0b6b5e") if gent else ("#eef2ff", "#3730a3")
        chips = "".join(
            f'<span style="display:inline-block;background-color:{bg};color:{fg};border-radius:999px;padding:3px 9px;'
            f'font-size:12px;margin:0 4px 4px 0">{s["t"]:%H:%M} {e(s["w"]["display"])}</span>'
            for s in x["chain"])
        o.append(f'<tr><td width="120" style="padding:5px 0;font-size:13px;font-weight:bold;vertical-align:top">{e(day_label(x["date"]))}'
                 f'<br><span style="font-weight:normal;color:#6b7280;font-size:12px">{e(SHORT.get(x["cinema"], x["cinema"]))}</span></td>'
                 f'<td style="padding:5px 0;vertical-align:top">{chips}</td></tr>')
    o.append("</table></td></tr>")
    # day cards
    for x in days:
        gent = x["cinema"] in GENT_KEYS
        ch = x["chain"]
        last = ch[-1]
        home = last["t"] + dt.timedelta(minutes=15 + last["dur"] + (20 if gent else 30))
        tags = (badge("WEEKEND", "#f76b15", ";margin-left:6px") if x["date"].weekday() >= 5 else "") + (
            badge("GENT", "#12a594", ";margin-left:6px") if gent else "")
        o.append(f'<tr><td style="padding:12px 20px 0"><table width="100%" cellpadding="0" cellspacing="0" '
                 f'style="border:1px solid #e5e7eb;border-radius:10px">'
                 f'<tr><td colspan="3" bgcolor="#f9fafb" style="background-color:#f9fafb;padding:9px 12px;border-bottom:1px solid #e5e7eb;border-radius:10px 10px 0 0">'
                 f'<b style="font-size:15px">{e(day_label(x["date"], True))}</b><span style="font-size:13px;color:#6b7280"> · '
                 f'{e(x["chain"][0]["w"]["cinemaName"])} · {len(ch)} film{"s" * (len(ch) != 1)} · home ~{home:%H:%M}</span>{tags}</td></tr>')
        for i, s in enumerate(ch):
            if i:
                prev = ch[i - 1]
                wait = int((s["t"] - prev["t"]).total_seconds() // 60) - prev["dur"]
                if wait > 30:
                    o.append(f'<tr><td colspan="3" style="padding:0 12px"><div style="border-top:1px dashed #e5e7eb;'
                             f'font-size:11px;color:#9ca3af;padding:3px 0 0 52px">{fmt_dur(wait) if wait >= 60 else f"{wait} min"} wait</div></td></tr>')
            f, w = s["w"]["film"], s["w"]
            end = s["t"] + dt.timedelta(minutes=15 + s["dur"])
            cid = poster_cid.get(f.get("posterThumb"))
            img = (f'<img src="{cid}" width="54" height="80" alt="" style="display:block;border-radius:4px">' if cid else
                   '<div style="width:54px;height:80px;border-radius:4px;background-color:#e5e7eb"></div>')
            meta = " · ".join(x for x in [str(f.get("year") or ""), fmt_dur(f.get("duration")), ", ".join(f.get("directors") or [])] if x)
            if w["kind"] == "watchlist":
                kb = badge("Watchlist", "#3e63dd")
            else:
                r = w.get("rating")
                kb = badge(f"Re-release · you rated ★{r:g}" if r else "Re-release · ♥ liked", "#8e4ec6")
            new = badge("NEW", "#e5484d", ";margin-left:4px") if s["key"] not in sent_keys and not test else ""
            al = also.get(w["norm"], [])
            also_txt = ""
            if al:
                parts = [f'{a["t"]:%a %-d %H:%M}' + ("" if a["w"]["cinema"] == s["w"]["cinema"] else f' ({SHORT.get(a["w"]["cinema"], "")})')
                         + (" new" if a["key"] not in sent_keys and not test else "") for a in al]
                also_txt = f'<div style="font-size:12px;color:#6b7280;margin-top:5px">Also: {e(" · ".join(parts))}</div>'
            link = f.get("url") or f.get("cinebelUrl") or "#"
            o.append(f'<tr><td width="58" style="padding:9px 0 9px 12px;vertical-align:top;text-align:center">'
                     f'<div style="font-size:16px;font-weight:bold">{s["t"]:%H:%M}</div>'
                     f'<div style="font-size:11px;color:#6b7280">until ~{end:%H:%M}</div></td>'
                     f'<td width="62" style="padding:9px 8px;vertical-align:top">{img}</td>'
                     f'<td style="padding:9px 12px 9px 0;vertical-align:top"><a href="{e(link)}" style="font-size:15px;font-weight:bold;'
                     f'color:#111827;text-decoration:none">{e(w["display"])}</a>{new}'
                     f'<div style="font-size:12px;color:#6b7280;margin-top:3px">{e(meta)}</div>'
                     f'<div style="margin-top:5px">{kb}</div>{also_txt}</td></tr>')
        o.append("</table></td></tr>")
    if others:
        o.append('<tr><td style="padding:14px 20px 0"><div style="font-size:12px;font-weight:bold;color:#6b7280;'
                 'text-transform:uppercase;margin-bottom:4px">Other options</div>')
        for title, txt in others:
            o.append(f'<div style="font-size:13px;padding:4px 0;border-bottom:1px solid #f3f4f6"><b>{e(title)}</b> '
                     f'<span style="color:#6b7280">· {e(txt)}</span></div>')
        o.append("</td></tr>")
    o.append('<tr><td style="padding:14px 20px 16px;font-size:11px;color:#9ca3af">Don\'t want a film suggested? '
             'Reply "exclude: &lt;title&gt;" or add it to exclude.txt in the cinema-data repo.</td></tr></table></div>')
    return "".join(o)


WARNINGS = []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["prepare", "build"])
    ap.add_argument("--sent")
    ap.add_argument("--calendar")
    ap.add_argument("--exclude", action="append", default=[])
    ap.add_argument("--test", action="store_true")
    ap.add_argument("--no-posters", action="store_true")
    a = ap.parse_args()

    data = load()
    age = NOW - dt.datetime.fromisoformat(data["generatedAt"].replace("Z", "+00:00")).astimezone(TZ).replace(tzinfo=None)
    if age > dt.timedelta(hours=24):
        WARNINGS.append(f"cinema data is {age.days}d {age.seconds // 3600}h old")
    for c in data["cinemas"]:
        if c.get("state") in ("stale", "missing"):
            WARNINGS.append(f'{c.get("name", c["key"])} data is {c["state"]}')

    sent_keys, sent_lines = read_sent(a.sent)
    wf = wanted_films(data, read_excludes(a.exclude))
    scs, dubbed = screenings(wf)

    if a.mode == "prepare":
        days, also, _, fit = plan(scs, None)
        cand = [s for s in fit]
        unsent = [s for s in cand if s["key"] not in sent_keys]
        first = min((s["t"] for s in unsent), default=NOW)
        last = max((s["t"] for s in cand), default=NOW)
        print(json.dumps({
            "wantedFilmsPlaying": len({w["norm"] for w in wf}),
            "candidateScreenings": len(cand),
            "unsent": len(unsent),
            "unsentExamples": sorted({f'{s["w"]["display"]} {s["time"]}' for s in unsent})[:8],
            "calendarFrom": min(NOW, first).strftime("%Y-%m-%dT%H:%M:00"),
            "calendarTo": (last + dt.timedelta(days=1)).strftime("%Y-%m-%dT00:00:00"),
            "warnings": WARNINGS,
        }, indent=1))
        return

    if not a.calendar:
        sys.exit("build needs --calendar")
    busy, sage = read_calendar(a.calendar)
    ticket = {w["norm"] for w in wf if has_ticket(w, sage)}
    scs = [s for s in scs if s["w"]["norm"] not in ticket]
    days, also, covered, fit = plan(scs, busy)

    # other options: wanted films (without a ticket) that got no slot
    others, seen = [], set(covered) | ticket
    for s in sorted(scs, key=lambda s: (s["gent"], s["t"])):
        n = s["w"]["norm"]
        if n in seen:
            continue
        seen.add(n)
        mine = [x for x in scs if x["w"]["norm"] == n]
        okt = [x for x in mine if x["ok"]]
        if okt:
            a1, b1 = window(okt[0])
            why = f'{okt[0]["t"]:%a %-d %H:%M} ({SHORT.get(okt[0]["w"]["cinema"], "")}) clashes with “{clash(a1, b1, busy)}”'
        else:
            why = "only during work hours: " + ", ".join(f'{x["t"]:%a %-d %H:%M}' for x in mine[:2])
        others.append((s["w"]["display"], why))
    for w in wf:
        if id(w) in dubbed and w["norm"] not in seen and w["norm"] not in ticket:
            seen.add(w["norm"])
            others.append((w["display"], f'only dubbed at {SHORT.get(w["cinema"], w["cinema"])}'))
    others = others[:10]

    shown = [s for x in days for s in x["chain"]] + [s for v in also.values() for s in v]
    new = [s for s in shown if s["key"] not in sent_keys]

    # posters as file-reference inline attachments
    attachments, poster_cid = [], {}
    for x in days:
        for s in x["chain"]:
            rel = s["w"]["film"].get("posterThumb")
            path = os.path.join(REPO, rel) if rel else None
            if rel and rel not in poster_cid and os.path.isfile(path) and len(attachments) < MAX_POSTERS and not a.no_posters:
                poster_cid[rel] = f"cid:att{len(attachments)}"
                attachments.append({"content": base64.b64encode(open(path, "rb").read()).decode(),
                                    "filename": f"poster{len(attachments)}.jpg", "mimeType": "image/jpeg", "inline": True})

    os.makedirs(OUT, exist_ok=True)
    htm = render(days, also, others, sent_keys, a.test, poster_cid)
    open(os.path.join(OUT, "email.html"), "w", encoding="utf-8").write(htm)
    json.dump(attachments, open(os.path.join(OUT, "attachments.json"), "w"), indent=1)

    # plain-text body: summary + cumulative SENT list (future screenings only) for the next run
    keep = {}
    for t, c, tm in sent_lines:
        if tm >= NOW.strftime("%Y-%m-%d %H:%M"):
            keep[key_of(t, c, tm)] = f"{t} | {c} | {tm}"
    for s in shown:
        keep[s["key"]] = f'{s["w"]["display"]} | {s["w"]["cinema"]} | {s["time"]}'
    lines = [f"Cinema suggestions, {day_label(NOW)}:"]
    for x in days:
        lines.append(f'{day_label(x["date"])} ({SHORT.get(x["cinema"], x["cinema"])}): ' +
                     ", ".join(f'{s["t"]:%H:%M} {s["w"]["display"]}' for s in x["chain"]))
    lines += ["", "SENT"] + sorted(keep.values(), key=lambda l: l.split(" | ")[2])
    open(os.path.join(OUT, "body.txt"), "w", encoding="utf-8").write("\n".join(lines) + "\n")

    print(json.dumps({
        "new": len(new),
        "newScreenings": [f'{s["w"]["display"]} {s["time"]}' for s in new][:15],
        "days": len(days),
        "films": sum(len(x["chain"]) for x in days),
        "posters": len(attachments),
        "subject": f'{"[TEST] " if a.test else ""}🎬 Cinema suggestions – {NOW.strftime("%A %-d %B")}',
        "files": {"htmlBody": "out/email.html", "body": "out/body.txt", "attachments": "out/attachments.json"},
        "htmlChars": len(htm),
        "warnings": WARNINGS,
    }, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
