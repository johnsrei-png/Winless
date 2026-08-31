// ============================================================
//  Winless — get-odds
//  Pulls live NFL odds (moneyline + spread) from The Odds API,
//  consensuses across all books, and returns a compact per-game
//  payload the front end uses to compute Best Loser scores.
//
//  Also snapshots each pull into Supabase (odds_history table) so
//  we can track LINE MOVEMENT over time — comparing the earliest
//  known ("opening") line for a game against the current one.
//
//  Env vars required (Netlify):  ODDS_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY
//  Free tier: https://the-odds-api.com  (500 req/mo is plenty —
//  the front end caches, and we only need a few pulls per week.)
// ============================================================

const ODDS_KEY = process.env.ODDS_API_KEY || "";
const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SB_KEY = process.env.SUPABASE_ANON_KEY || "";

// ESPN uses a few different abbreviations than The Odds API team names.
// We key everything by full team name from The Odds API and let the front
// end map to abbreviations, so no abbr fixing needed here.

// median helper (robust consensus vs. mean, ignores one weird book)
function median(nums) {
  const a = nums.filter(n => n != null && !isNaN(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// A stable key for a game across snapshots — teams + scheduled kickoff.
// (If a game gets flexed to a new time mid-week, it'll start a fresh
// history rather than merging with the old snapshots — an acceptable
// edge case rather than something worth over-engineering around.)
function gameKey(home, away, commence) {
  return `${home}__${away}__${commence}`;
}

async function sbInsert(rows) {
  if (!SB_URL || !SB_KEY || !rows.length) return;
  try {
    await fetch(`${SB_URL}/rest/v1/odds_history`, {
      method: "POST",
      headers: {
        apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
        "Content-Type": "application/json", Prefer: "return=minimal",
      },
      body: JSON.stringify(rows),
    });
  } catch (e) { /* snapshot failures shouldn't break the odds response */ }
}

// Earliest snapshot per game_key = the "opening" line, for movement comparisons.
async function sbOpeningLines(keys) {
  if (!SB_URL || !SB_KEY || !keys.length) return {};
  try {
    const filter = `game_key=in.(${keys.map(k => `"${k}"`).join(",")})`;
    const res = await fetch(`${SB_URL}/rest/v1/odds_history?${filter}&order=captured_at.asc`, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    });
    if (!res.ok) return {};
    const rows = await res.json();
    const opening = {};
    rows.forEach(r => { if (!opening[r.game_key]) opening[r.game_key] = r; });   // first seen = earliest (sorted asc)
    return opening;
  } catch (e) { return {}; }
}

exports.handler = async () => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };
  if (!ODDS_KEY) {
    return { statusCode: 200, headers: cors,
      body: JSON.stringify({ ok: false, reason: "no_key", games: [] }) };
  }

  try {
    const url = `https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds`
      + `?apiKey=${ODDS_KEY}`
      + `&regions=us`
      + `&markets=h2h,spreads`
      + `&oddsFormat=american`;
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text();
      return { statusCode: 200, headers: cors,
        body: JSON.stringify({ ok: false, reason: `odds_api_${res.status}`, detail: body.slice(0, 200), games: [] }) };
    }
    const data = await res.json();

    const games = (data || []).map(g => {
      const home = g.home_team, away = g.away_team;
      // collect every book's moneyline + spread for each side
      const mlHome = [], mlAway = [], spHome = [], spAway = [];
      (g.bookmakers || []).forEach(bk => {
        (bk.markets || []).forEach(mk => {
          if (mk.key === "h2h") {
            mk.outcomes.forEach(o => {
              if (o.name === home) mlHome.push(o.price);
              else if (o.name === away) mlAway.push(o.price);
            });
          } else if (mk.key === "spreads") {
            mk.outcomes.forEach(o => {
              if (o.name === home) spHome.push(o.point);
              else if (o.name === away) spAway.push(o.point);
            });
          }
        });
      });
      return {
        home, away,
        commence: g.commence_time,
        mlHome: median(mlHome), mlAway: median(mlAway),   // consensus moneylines
        spreadHome: median(spHome), spreadAway: median(spAway), // consensus spreads
        books: (g.bookmakers || []).length,
        game_key: gameKey(home, away, g.commence_time),
      };
    }).filter(g => g.mlHome != null || g.spreadHome != null);

    // snapshot this pull for future line-movement comparisons (fire-and-forget-ish,
    // but awaited so a cold start doesn't get killed before it writes)
    await sbInsert(games.map(g => ({
      game_key: g.game_key, home: g.home, away: g.away, commence: g.commence,
      ml_home: g.mlHome, ml_away: g.mlAway, spread_home: g.spreadHome, spread_away: g.spreadAway,
      books: g.books,
    })));

    // pull each game's opening (earliest-known) line to include in the response
    const opening = await sbOpeningLines(games.map(g => g.game_key));
    games.forEach(g => {
      const o = opening[g.game_key];
      if (o) {
        g.openingMlHome = o.ml_home; g.openingMlAway = o.ml_away;
        g.openingSpreadHome = o.spread_home; g.openingSpreadAway = o.spread_away;
        g.openingCapturedAt = o.captured_at;
      }
    });

    return { statusCode: 200, headers: cors,
      body: JSON.stringify({ ok: true, count: games.length, games }) };
  } catch (e) {
    return { statusCode: 200, headers: cors,
      body: JSON.stringify({ ok: false, reason: "exception", detail: String(e).slice(0, 200), games: [] }) };
  }
};
