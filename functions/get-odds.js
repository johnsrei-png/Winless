// ============================================================
//  Winless — get-odds
//  Pulls live NFL odds (moneyline + spread) from The Odds API,
//  consensuses across all books, and returns a compact per-game
//  payload the front end uses to compute Best Loser scores.
//
//  Env var required (Netlify):  ODDS_API_KEY
//  Free tier: https://the-odds-api.com  (500 req/mo is plenty —
//  the front end caches, and we only need a few pulls per week.)
// ============================================================

const ODDS_KEY = process.env.ODDS_API_KEY || "";

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
      };
    }).filter(g => g.mlHome != null || g.spreadHome != null);

    return { statusCode: 200, headers: cors,
      body: JSON.stringify({ ok: true, count: games.length, games }) };
  } catch (e) {
    return { statusCode: 200, headers: cors,
      body: JSON.stringify({ ok: false, reason: "exception", detail: String(e).slice(0, 200), games: [] }) };
  }
};
