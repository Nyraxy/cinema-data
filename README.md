# cinema-data

A GitHub Action that runs every 3 hours (plus extra runs on Monday evening) and writes `data/cinema.json` with:

- **Showtimes** from cinebel.dhnet.be for the next ~2 weeks at Pathé Sint-Niklaas, Kinepolis Gent, Sphinx and Studio Skoop
  (pathe.be itself blocks requests from GitHub's servers)
- **Letterboxd (Nyrax)**: the watchlist (live), and watched films with ratings/likes from the Letterboxd export in
  `letterboxd-export/` plus the RSS feed and first films page for recent activity

A daily Claude scheduled task reads this file together with Google Calendar and emails cinema suggestions.

Run locally: `node scrape.mjs` (Node 20+, no dependencies).
