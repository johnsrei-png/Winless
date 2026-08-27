// ============================================================
//  Winless — scheduled auto-resolution
//  Fetches final NFL scores from ESPN and eliminates entries
//  whose assigned team WON or TIED (either kills the entry).
//  Idempotent: only touches games that are final; safe to run often.
// ============================================================

const SEASON = 2025;          // NFL season year to query
const SEASON_TYPE = 2;        // 2 = regular season

// Supabase config comes from Netlify env vars (set in dashboard):
//   SUPABASE_URL, SUPABASE_ANON_KEY
const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SB_KEY = process.env.SUPABASE_ANON_KEY || "";

// ESPN uses the same abbreviations we store, with a few exceptions we normalize.
const ESPN_FIX = { WSH: "WAS", LAR: "LAR", LV: "LV", JAX: "JAX", ARI: "ARI" };
function fixAbbr(a) { return ESPN_FIX[a] || a; }

async function sb(path, opts = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  const txt = await res.text();
  return txt ? JSON.parse(txt) : null;
}

// Pull final results for a given NFL week -> { TEAM: 'won'|'lost'|'tied' }
async function fetchWeekResults(week) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard`
            + `?seasontype=${SEASON_TYPE}&week=${week}&dates=${SEASON}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ESPN ${res.status}`);
  const data = await res.json();
  const out = {};
  for (const ev of data.events || []) {
    const comp = ev.competitions?.[0];
    if (!comp) continue;
    const final = comp.status?.type?.completed === true;
    if (!final) continue;                       // skip games not yet final
    const cs = comp.competitors || [];
    if (cs.length !== 2) continue;
    const [a, b] = cs;
    const sa = Number(a.score), sb_ = Number(b.score);
    const abbrA = fixAbbr(a.team?.abbreviation), abbrB = fixAbbr(b.team?.abbreviation);
    if (sa === sb_) { out[abbrA] = "tied"; out[abbrB] = "tied"; }
    else if (sa > sb_) { out[abbrA] = "won"; out[abbrB] = "lost"; }
    else { out[abbrA] = "lost"; out[abbrB] = "won"; }
  }
  return out;
}

// Resolve one week's assignments against results.
// Loser pool: team WON or TIED => that entry is eliminated.
async function resolveWeek(week, results) {
  if (!Object.keys(results).length) return { week, note: "no final games yet", changed: 0 };

  const assigns = await sb(`assignments?week_number=eq.${week}`);
  if (!assigns || !assigns.length) return { week, note: "no assignments", changed: 0 };

  const entries = await sb(`entries?order=id.asc`);
  const entryById = Object.fromEntries(entries.map(e => [e.id, e]));

  let changed = 0;
  const deadEntryIds = new Set();

  for (const a of assigns) {
    const outcome = results[a.team];        // 'won' | 'lost' | 'tied' | undefined
    if (!outcome) continue;                 // game not final yet -> leave pending
    const survived = outcome === "lost";    // team lost = you survive
    const newResult = survived ? "survived" : "eliminated";
    if (a.result !== newResult) {
      await sb(`assignments?id=eq.${a.id}`, {
        method: "PATCH", body: JSON.stringify({ result: newResult }),
      });
      changed++;
    }
    if (!survived) deadEntryIds.add(a.entry_id);
  }

  // Flip entry status for any entry that died this week (and isn't already dead).
  for (const eid of deadEntryIds) {
    const e = entryById[eid];
    if (e && e.status !== "dead") {
      await sb(`entries?id=eq.${eid}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "dead", died_week: week }),
      });
    }
  }

  return { week, changed, eliminated: [...deadEntryIds] };
}

// Grade every individual pick on each player's ranked list for a week.
// Loser pool: pick is "correct" if the team LOST. Won or tied = incorrect.
// Stamps picks.result = 'correct' | 'incorrect' (leaves pending if game not final).
async function gradePicks(week, results) {
  if (!Object.keys(results).length) return { graded: 0 };
  const picks = await sb(`picks?week_number=eq.${week}`);
  if (!picks || !picks.length) return { graded: 0 };
  let graded = 0;
  for (const p of picks) {
    const outcome = results[p.team];
    if (!outcome) continue;
    const newResult = outcome === "lost" ? "correct" : "incorrect";
    if (p.result !== newResult) {
      await sb(`picks?id=eq.${p.id}`, {
        method: "PATCH", body: JSON.stringify({ result: newResult }),
      });
      graded++;
    }
  }
  return { graded };
}

// Resolve the whole field: mark each field entry's elimination week.
// A field entry dies the first week its picked team won or tied.
// We store an "out_week" on each field_picks row (null = still alive).
async function resolveField(allWeekResults) {
  const field = await sb(`field_picks`);
  if (!field || !field.length) return { fieldChanged: 0 };
  let fieldChanged = 0;

  for (const f of field) {
    let picks; try { picks = JSON.parse(f.picks); } catch { picks = []; }
    let outWeek = null;
    for (let i = 0; i < picks.length; i++) {
      const team = picks[i];
      if (!team) continue;
      const wk = i + 1;
      const res = allWeekResults[wk]?.[team];
      if (!res) continue;                 // that week not final yet
      if (res === "won" || res === "tied") { outWeek = wk; break; }
    }
    if ((f.out_week ?? null) !== outWeek) {
      await sb(`field_picks?id=eq.${f.id}`, {
        method: "PATCH", body: JSON.stringify({ out_week: outWeek }),
      });
      fieldChanged++;
    }
  }
  return { fieldChanged };
}

exports.handler = async () => {
  if (!SB_URL || !SB_KEY) {
    return { statusCode: 500, body: "Missing SUPABASE_URL / SUPABASE_ANON_KEY env vars." };
  }
  try {
    // Resolve any week that is locked or resolved (not still open for picks).
    const allWeeks = await sb(`weeks?order=week_number.asc`);
    const weeks = (allWeeks || []).filter(w => w.status === "locked" || w.status === "resolved");
    const report = [];
    const allWeekResults = {};
    for (const w of weeks || []) {
      const results = await fetchWeekResults(w.week_number);
      allWeekResults[w.week_number] = results;
      report.push(await resolveWeek(w.week_number, results));
      await gradePicks(w.week_number, results);
    }
    // Resolve the field too (only if any week is in play)
    let fieldReport = { fieldChanged: 0 };
    if (Object.keys(allWeekResults).length) {
      fieldReport = await resolveField(allWeekResults);
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true, report, ...fieldReport }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};

// Netlify schedule (UTC). Aims to run shortly AFTER each NFL game window closes,
// so entries flip as results finalize. Idempotent, so overlap is harmless.
//   - Fri 05:00 UTC  (~1am ET Fri)   -> catches Thursday Night Football
//   - Sun 21:00 UTC  (~5pm ET)       -> catches the early Sunday slate
//   - Mon 04:00 UTC  (~11pm-12am ET) -> catches late Sunday + Sunday night
//   - Tue 08:00 UTC  (~3-4am ET)     -> finalizer, catches Monday Night Football
exports.config = {
  schedule: "0 5 * * 5, 0 21 * * 0, 0 4 * * 1, 0 8 * * 2",
};
