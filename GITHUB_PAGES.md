# GitHub Pages deployment

This repository includes a static GitHub Pages build in `docs/`.

1. Push the repository to GitHub.
2. Open repository Settings > Pages.
3. Set Source to `Deploy from a branch`.
4. Select the branch and `/docs` folder.
5. Save.

The Pages version stores events, labels, and settings in Supabase. It does not use the Flask server or SQLite database. Configure Supabase with `SUPABASE_SETUP.md` before using the public app.
