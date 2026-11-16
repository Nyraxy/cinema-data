# cinema-data

A GitHub Action that runs every 3 hours (plus extra runs on Monday evening) and writes `data/cinema.json` with:

- **Pathé Sint-Niklaas**: every film with its showtimes for the next 6 weeks (title, original title, runtime, director, special event flag)
- **Letterboxd (Nyrax)**: the watchlist, plus every watched film with its rating and whether it's liked

A daily Claude scheduled task reads this file together with Google Calendar and emails cinema suggestions.

Run locally: `node scrape.mjs` (Node 20+, no dependencies).
Settings (env vars): `LETTERBOXD_USER`, `PATHE_CINEMA`, `DAYS_AHEAD`.
