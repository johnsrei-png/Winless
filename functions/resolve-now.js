// ============================================================
//  Winless — manual "Resolve now" endpoint
//  Same logic as the scheduled resolve-results.js, but callable
//  on demand from the UI. Returns a small report.
// ============================================================

const SEASON = 2026;
const SEASON_TYPE = 2;

const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SB_KEY = process.env.SUPABASE_ANON_KEY || "";

const ESPN_FIX = { WSH: "WAS" };
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
  if (!res.ok) {
    const body = await res.text();
    console.error(`Supabase error on path "${path}": ${res.status} ${body}`);
    throw new Error(`${res.status}: ${body}`);
  }
  const txt = await res.text();
  return txt ? JSON.parse(txt) : null;
}

async function fetchWeekResults(week) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard`
            + `?seasontype=${SEASON_TYPE}&week=${week}&dates=${SEASON}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ESPN ${res.status}`);
  const data = await res.json();
  const out = {};
  for (const ev of data.events || []) {
    const comp = ev.competitions?.[0];
    if (!comp || comp.status?.type?.completed !== true) continue;
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

async function resolveWeek(week, results) {
  if (!Object.keys(results).length) return { week, note: "no final games yet", changed: 0 };
  const assigns = await sb(`assignments?week_number=eq.${week}`);
  if (!assigns || !assigns.length) return { week, note: "no assignments", changed: 0 };
  const entries = await sb(`entries?order=id.asc`);
  const entryById = Object.fromEntries(entries.map(e => [e.id, e]));

  let changed = 0;
  const deadEntryIds = new Set();
  for (const a of assigns) {
    const outcome = results[a.team];
    if (!outcome) continue;
    const survived = outcome === "lost";
    const newResult = survived ? "survived" : "eliminated";
    if (a.result !== newResult) {
      await sb(`assignments?id=eq.${a.id}`, {
        method: "PATCH", body: JSON.stringify({ result: newResult }),
      });
      changed++;
    }
    if (!survived) deadEntryIds.add(a.entry_id);
  }
  for (const eid of deadEntryIds) {
    const e = entryById[eid];
    if (e && e.status !== "dead") {
      await sb(`entries?id=eq.${eid}`, {
        method: "PATCH", body: JSON.stringify({ status: "dead", died_week: week }),
      });
    }
  }
  return { week, changed, eliminated: [...deadEntryIds] };
}

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

async function resolveField(allWeekResults) {
  const field = await sb(`field_picks`);
  if (!field || !field.length) return { fieldChanged: 0 };
  let fieldChanged = 0;
  for (const f of field) {
    let picks; try { picks = JSON.parse(f.picks); } catch { picks = []; }
    let outWeek = null;
    for (let i = 0; i < picks.length; i++) {
      const team = picks[i]; if (!team) continue;
      const res = allWeekResults[i + 1]?.[team];
      if (!res) continue;
      if (res === "won" || res === "tied") { outWeek = i + 1; break; }
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
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: "Missing env vars" }) };
  }
  try {
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
    let fieldReport = { fieldChanged: 0 };
    if (Object.keys(allWeekResults).length) fieldReport = await resolveField(allWeekResults);
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, report, ...fieldReport }),
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
