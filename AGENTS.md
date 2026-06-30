# Notes for this repository

- GitHub Pages public site is served from the `gh-pages` branch, not only from `main/docs`.
  After changing files under `docs/`, also sync and push the built/static contents to `gh-pages`.
- The GitHub Pages version uses Supabase via `docs/static/local-api.js`.
- Do not split multi-day all-day events into per-day pseudo events.
  FullCalendar should receive the original event with `start` and exclusive `end`, and handle native multi-day rendering.
- Do not reintroduce `.multi-day-segment`, `multi_day_lane`, or `expandMultiDayAllDayEvents`.
- FullCalendar is vendored at `docs/static/fullcalendar-6.1.18.min.js` and `static/fullcalendar-6.1.18.min.js`.
  Keep the HTML script tags pointed at the local asset, not the CDN.
- If calendar UI changes are made, verify on the public URL after pushing `gh-pages`, logging in with a real account if needed.
- When changing public assets, bump `docs/service-worker.js` `CACHE_VERSION`.
