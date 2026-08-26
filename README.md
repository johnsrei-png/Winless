# Winless — NFL Loser Pool

One crew, six shared entries. Each week you three submit ranked lists of teams
you expect to lose; points sum into a master ranking; you place the top teams
onto entries by hand. An entry dies if its team wins.

## Setup (one time)

1. **Paste your Supabase values** into `public/config.js`:
   - `SUPABASE_URL` — your Project URL
   - `SUPABASE_ANON_KEY` — the anon / publishable key (safe in the browser)
2. Make sure the schema + RLS policies have been run in Supabase (already done).
3. **Deploy to Netlify** — same as BBR. Drag the folder into Netlify, or push
   the repo and connect it. Publish directory is `public` (set in `netlify.toml`).

## Opening a week (commissioner)

The app reads the most recent row in the `weeks` table. To start a week, add a
row in the Supabase **Table Editor** → `weeks`:

| column            | value                                  |
|-------------------|----------------------------------------|
| `week_number`     | e.g. `1`                               |
| `entries_remaining` | how many entries are still alive     |
| `picks_required`  | `entries_remaining + 2`                |
| `status`          | `open`                                 |

Everyone then sees Week N and submits their ranked list. Set `status` to
`locked` once all three are in and you're placing entries (that screen comes in
the next build step).

## What's built so far

- **Step 1:** name-select (localStorage), reads real players from Supabase
- **Step 2:** pick submission — ranked slots sized to `picks_required`,
  dedupe guard, resubmit-to-edit, "waiting on ___" tracker

## Coming next

- Aggregate reveal (master ranking once all three submit)
- Manual assignment board (place teams on entries, per-entry reuse flagged)
- Auto-resolution from live NFL scores
- Season history + standings
