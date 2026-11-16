# cinema-data

A GitHub Action that runs every 3 hours (plus extra runs on Monday evening) and writes `data/cinema.json` with:

- **Pathé Sint-Niklaas**: all films and showtimes for the next ~2 months, from Pathé's own API (fetched through a
  full Chrome on a virtual display, because Pathé blocks plain requests)
- **Sphinx and Studio Skoop (Gent)**: showtimes for the next ~2 days from cinebel.dhnet.be
- **Letterboxd (Nyrax)**: the watchlist (live), and watched films with ratings/likes from the Letterboxd export in
  `letterboxd-export/` plus the RSS feed and first films page for recent activity

To stop a film from being suggested (e.g. one you'd rather watch at home), add it to `exclude.txt`.

A daily Claude scheduled task reads this file together with Google Calendar and emails cinema suggestions.

Run locally: `node scrape.mjs` (Node 20+, no dependencies).
