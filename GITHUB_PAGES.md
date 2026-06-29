# GitHub Pages deployment

This repository includes a static GitHub Pages build in `docs/`.

1. Push the repository to GitHub.
2. Open repository Settings > Pages.
3. Set Source to `Deploy from a branch`.
4. Select the branch and `/docs` folder.
5. Save.

The Pages version stores events, labels, and settings in the browser's localStorage. It does not use the Flask server or SQLite database. Use ICS export/import from the drawer to back up or move data between browsers.
