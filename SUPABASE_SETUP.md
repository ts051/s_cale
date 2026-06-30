# Supabase setup

This GitHub Pages build stores calendar data in Supabase instead of browser localStorage.

## 1. Create a Supabase project

Create a new project at Supabase.

In Authentication > Providers > Email, disable public sign-ups for this app. Create the two allowed users manually in the Supabase dashboard.

## 2. Create tables and policies

Open SQL Editor in the Supabase dashboard and run:

```sql
-- Copy and run the contents of supabase/schema.sql
```

The schema enables Row Level Security. Authenticated users can:

- read shared events and their own private events
- edit shared events
- edit their own private events
- read/edit shared labels and their own private labels

## 3. Configure the GitHub Pages app

Open `docs/static/supabase-config.js` and set:

```js
window.WHITE_TREE_SUPABASE = {
  url: 'https://YOUR_PROJECT_ID.supabase.co',
  anonKey: 'YOUR_SUPABASE_ANON_KEY'
};
```

The anon key is safe to publish when Row Level Security is enabled. Do not put the service role key in this file.

## 4. Deploy

Commit and push the updated `docs/static/supabase-config.js`.

The app URL remains:

```text
https://ts051.github.io/s_cale/
```

## Login behavior

The existing username/password screen is reused.

The app only signs in existing users. It does not create accounts from the public login page.

Create users manually in Authentication > Users. The app maps the visible username to an internal email:

```text
username@whitetree.local
```

For example, create only:

```text
husband@whitetree.local
wife@whitetree.local
```

Then users log in with `husband` or `wife` plus the password you set in Supabase.
