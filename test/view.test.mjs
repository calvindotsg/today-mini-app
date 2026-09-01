import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceWeekState, ContractError } from "../src/reduce.js";
import { buildView, parseSgt, sgtDate, STALE_AFTER_HOURS } from "../src/view.js";

const SGT = (s) => parseSgt(s);
const GEN = "2026-08-24T05:00:00+08:00";

function payload(days, meta = {}, generatedAt = GEN) {
  return {
    v: 1, generatedAt,
    meta: { weekLabel: "Week of 24–30 August 2026", weekStart: "2026-08-24", weekEnd: "2026-08-30", ...meta },
    days,
  };
}
const day = (date, dow, sessions) => ({ date, dow, sessions });
const sess = (o) => ({ kind: "Run · 18:30", title: "Long run", status: "planned", ...o });

test("Singapore time is read as +08:00 in both directions", () => {
  assert.equal(SGT("2026-08-24T06:15"), Date.UTC(2026, 7, 23, 22, 15));
  assert.equal(sgtDate(Date.UTC(2026, 7, 23, 17, 0)), "2026-08-24"); // 01:00 SGT the next day
  assert.equal(sgtDate(Date.UTC(2026, 7, 23, 15, 0)), "2026-08-23"); // 23:00 SGT the same day
  assert.equal(parseSgt(undefined), null);
  assert.equal(parseSgt("not a date"), null);
});

test("Now is the next PLANNED session ahead of the clock; Next is the one after", () => {
  const p = payload([
    day("2026-08-24", "Monday", [
      sess({ status: "done", title: "Gym", at: "2026-08-24T06:15" }),
      sess({ title: "Evening run", at: "2026-08-24T18:00", leaveBy: "2026-08-24T17:15" }),
    ]),
    day("2026-08-25", "Tuesday", [sess({ title: "ARC Tuesday", at: "2026-08-25T19:00" })]),
  ]);
  const v = buildView(p, SGT("2026-08-24T09:00"));
  assert.equal(v.ok, true);
  assert.equal(v.now.title, "Evening run");
  assert.equal(v.next.title, "ARC Tuesday");
  assert.equal(v.laterCount, 0);
});

test("a session that finished long ago is behind you and never occupies Now", () => {
  const p = payload([day("2026-08-24", "Monday", [
    sess({ title: "Morning", at: "2026-08-24T06:15" }),
    sess({ title: "Evening", at: "2026-08-24T18:00" }),
  ])]);
  const v = buildView(p, SGT("2026-08-24T12:00"));
  assert.equal(v.now.title, "Evening");
  assert.equal(v.inProgress, false);
  assert.equal(v.next, null);
});

// THE SESSION HE IS STANDING IN. Before this, Now flipped to tomorrow's gym at the instant
// tonight's run began -- which is the instant he is at the start line with the phone in his hand.
test("a session under way holds Now until the artifact says it is over", () => {
  const p = payload([
    day("2026-08-24", "Monday", [sess({ title: "Meeting", at: "2026-08-24T20:00", until: "2026-08-24T21:00" })]),
    day("2026-08-25", "Tuesday", [sess({ title: "Gym", at: "2026-08-25T06:15" })]),
  ]);
  const during = buildView(p, SGT("2026-08-24T20:30"));
  assert.equal(during.now.title, "Meeting", "under way is not the same as behind you");
  assert.equal(during.inProgress, true);
  assert.equal(during.next.title, "Gym", "and what follows is still what follows");

  const after = buildView(p, SGT("2026-08-24T21:01"));
  assert.equal(after.now.title, "Gym");
  assert.equal(after.inProgress, false);
});

// `until` is stated on 2 of the 20 sessions in the live week, so the fallback IS the common path.
test("with no stated end, a session holds Now for the grace and no longer", () => {
  const p = payload([
    day("2026-08-24", "Monday", [sess({ title: "ARC", at: "2026-08-24T19:24", leaveBy: "2026-08-24T19:00" })]),
    day("2026-08-25", "Tuesday", [sess({ title: "Gym", at: "2026-08-25T06:15" })]),
  ]);
  const during = buildView(p, SGT("2026-08-24T20:00"));
  assert.equal(during.now.title, "ARC");
  assert.equal(during.inProgress, true);

  // 19:24 + 90 min = 20:54. Past that the evening is his and tomorrow morning is the question.
  const after = buildView(p, SGT("2026-08-24T21:00"));
  assert.equal(after.now.title, "Gym", "the grace must not hide tomorrow all evening");
  assert.equal(after.inProgress, false);
});

// NEGATIVE CONTROL 5 -- the grace must never swallow the next thing he has to leave for. This is
// Sunday 6 September as published: a wake alarm at 04:15 that states no end, and a ride whose
// leaveBy is 04:55. A blind 90-minute hold covers 04:55 and hides the one number this app exists
// to show.
test("a session's hold ends where the next session's claim on him begins", () => {
  const p = payload(
    [day("2026-09-06", "Sunday", [
      sess({ kind: "Wake · 04:15", title: "Wake", at: "2026-09-06T04:15" }),
      sess({ kind: "Ride · 05:45", title: "KCC SUN Ride", at: "2026-09-06T05:45", leaveBy: "2026-09-06T04:55" }),
    ])],
    { weekStart: "2026-08-31", weekEnd: "2026-09-06" },
    "2026-09-06T04:00:00+08:00",
  );
  const woken = buildView(p, SGT("2026-09-06T04:30"));
  assert.equal(woken.now.title, "Wake");
  assert.equal(woken.inProgress, true);

  const leaving = buildView(p, SGT("2026-09-06T04:56"));
  assert.equal(leaving.now.title, "KCC SUN Ride", "04:55 must not be buried under the alarm's grace");
  assert.equal(leaving.inProgress, false, "the ride has not started -- the screen must still say Leave by");
});

test("an `until` at or before the start is upstream nonsense, not an instant expiry", () => {
  const p = payload([day("2026-08-24", "Monday", [
    sess({ title: "Backwards", at: "2026-08-24T18:00", until: "2026-08-24T17:00" }),
  ])]);
  const v = buildView(p, SGT("2026-08-24T18:30"));
  assert.equal(v.now.title, "Backwards", "a session must not expire at birth on bad data");
  assert.equal(v.inProgress, true);
});

// NEGATIVE CONTROL 1 -- every optional field absent. `leaveBy` is absent from 0 of 17 sessions in
// one real artifact, so this is the common case, not the edge case.
test("a session with every optional field absent still produces a renderable Now", () => {
  const p = payload([day("2026-08-24", "Monday", [
    { kind: "Rest · by design", title: "No running tonight", status: "planned" },
  ])]);
  const v = buildView(p, SGT("2026-08-24T09:00"));
  assert.equal(v.now.title, "No running tonight");
  assert.equal(v.now.leaveBy, undefined);
  assert.equal(v.now.at, undefined);
  assert.equal(v.now.startMs, null);
  assert.equal(v.emptyReason, null);
});

// NEGATIVE CONTROL 2 -- a rest day. Nothing actionable must NOT read as a broken app.
test("a day whose sessions are all done/missed/skipped reports nothing-left, not an error", () => {
  const p = payload([day("2026-08-24", "Monday", [
    sess({ status: "done" }), sess({ status: "missed" }), sess({ status: "skipped_by_design" }),
  ])]);
  const v = buildView(p, SGT("2026-08-24T09:00"));
  assert.equal(v.ok, true);
  assert.equal(v.now, null);
  assert.equal(v.emptyReason, "nothing-left");
  assert.equal(v.coversToday, true);
});

// NEGATIVE CONTROL 3 -- stale. Without this the app would show yesterday's session as today's.
test("data older than the threshold is flagged stale; fresher data is not", () => {
  const now = SGT("2026-08-24T09:00");
  const fresh = buildView(payload([], {}, new Date(now - 2 * 3_600_000).toISOString()), now);
  assert.equal(fresh.stale, false);
  const old = buildView(payload([], {}, new Date(now - (STALE_AFTER_HOURS + 1) * 3_600_000).toISOString()), now);
  assert.equal(old.stale, true);
  const undated = buildView({ v: 1, meta: { weekLabel: "x", weekStart: "2026-08-24", weekEnd: "2026-08-30" }, days: [] }, now);
  assert.equal(undated.stale, true, "no generatedAt must read as stale, never as fresh");
  assert.equal(undated.ageHours, null);
});

// NEGATIVE CONTROL 4 -- an empty days array must say something honest, not paint a blank screen.
test("an empty days array is an honest empty state", () => {
  const v = buildView(payload([]), SGT("2026-08-24T09:00"));
  assert.equal(v.ok, true);
  assert.equal(v.now, null);
  assert.equal(v.emptyReason, "empty");
});

// The live case on the day this was built: the published plan's week had already ended.
test("a plan for another week is reported as not covering today -- separately from staleness", () => {
  const now = SGT("2026-08-31T06:00");
  const v = buildView(payload([day("2026-08-24", "Monday", [sess({})])], {}, new Date(now - 3_600_000).toISOString()), now);
  assert.equal(v.stale, false, "pushed an hour ago -- fresh");
  assert.equal(v.coversToday, false, "and still useless for today");
  assert.equal(v.emptyReason, "other-week");
  assert.equal(v.now, null);
});

test("only today and the next two days are in the window", () => {
  const p = payload([
    day("2026-08-24", "Monday", [sess({ title: "d0" })]),
    day("2026-08-26", "Wednesday", [sess({ title: "d2" })]),
    day("2026-08-27", "Thursday", [sess({ title: "d3 — outside the window" })]),
  ]);
  const v = buildView(p, SGT("2026-08-24T09:00"));
  assert.equal(v.now.title, "d0");
  assert.equal(v.next.title, "d2");
  assert.equal(v.laterCount, 0, "Thursday is day 3 and must not be counted");
});

test("untimed sessions sort after timed ones on the same day and are still counted", () => {
  const p = payload([day("2026-08-24", "Monday", [
    { kind: "Kit · what you carry", title: "Kit", status: "planned" },
    sess({ title: "Run", at: "2026-08-24T18:00" }),
    { kind: "Fuel · during", title: "Fuel", status: "planned" },
  ])]);
  const v = buildView(p, SGT("2026-08-24T09:00"));
  assert.equal(v.now.title, "Run");
  assert.equal(v.next.title, "Kit");
  assert.equal(v.laterCount, 1);
});

test("a malformed or missing payload is an honest error, never a blank ok", () => {
  assert.deepEqual(buildView(null, Date.now()).ok, false);
  assert.deepEqual(buildView({ v: 99 }, Date.now()).ok, false);
  assert.match(buildView(null, Date.now()).error, /published/);
});

test("reduceWeekState refuses a shape it does not understand, rather than emitting half a plan", () => {
  assert.throws(() => reduceWeekState(null, { generatedAt: GEN }), ContractError);
  assert.throws(() => reduceWeekState({ meta: {}, days: [] }, { generatedAt: GEN }), ContractError);
  assert.throws(() => reduceWeekState({ meta: { weekLabel: "x", weekStart: "nope", weekEnd: "2026-08-30" }, days: [] }, { generatedAt: GEN }), ContractError);
  assert.throws(() => reduceWeekState({
    meta: { weekLabel: "x", weekStart: "2026-08-24", weekEnd: "2026-08-30" },
    days: [{ date: "2026-08-24", sessions: [{ kind: "k", title: "t" }] }],
  }, { generatedAt: GEN }), ContractError, "a session without status must not reduce");
});

test("reduce drops absent and empty fields rather than emitting them as empty", () => {
  const out = reduceWeekState({
    meta: { weekLabel: "x", weekStart: "2026-08-24", weekEnd: "2026-08-30", plannedKm: 40.41, prevKm: 1 },
    days: [{ date: "2026-08-24", dow: "Monday", sessions: [
      { kind: "k", title: "t", status: "planned", bring: [], place: "  ", leaveBy: null, oneRule: "hold form", why: "not published" },
    ] }],
  }, { generatedAt: GEN });
  const s = out.days[0].sessions[0];
  assert.equal("bring" in s, false);
  assert.equal("place" in s, false);
  assert.equal("leaveBy" in s, false);
  assert.equal(s.oneRule, "hold form");
  assert.equal("why" in s, false, "a field outside the allowlist must not be published");
  assert.equal("prevKm" in out.meta, false, "meta is an allowlist too");
  assert.equal(out.meta.plannedKm, 40.41);
});

// ── the week screen ─────────────────────────────────────────────────────────────────────────
//
// The controls below exist because the week screen fails DIFFERENTLY from the Now slot. Now has
// one job and shows nothing when it cannot do it; the week always draws seven rows, so its
// failures are quiet ones -- a bar at zero where no ceiling was published, a day filed under the
// wrong heading for the eight hours after Singapore's midnight, a field published by accident.

const WEEK_META = { plannedKm: 44.23, ceilingKm: 48.57, priorWeekKm: 40.471, kiprunDate: "2026-09-27" };

test("the week carries every day, classified against the request's own clock", () => {
  const p = payload([
    day("2026-08-24", "Monday", [sess({ status: "done" }), sess({ status: "done" })]),
    day("2026-08-25", "Tuesday", [sess({ at: "2026-08-25T19:00" })]),
    day("2026-08-26", "Wednesday", []),
  ], WEEK_META);
  const w = buildView(p, SGT("2026-08-25T09:00")).week;

  assert.deepEqual(w.days.map((d) => d.phase), ["past", "today", "ahead"]);
  assert.equal(w.days[0].counts.done, 2);
  assert.equal(w.days[2].sessions.length, 0, "a day with nothing on it is still a day");
  assert.equal(w.daysToKiprun, 33);
});

// A SPENT DAY IS SUMMARISED BY EVERYTHING THAT HAPPENED ON IT. The first version counted only
// `done`, so a day of one done and two missed collapsed to "1 done" -- which reads as a light day
// when it was the opposite. This is the control that would have caught that, and a count that
// simply returned `sessions.length` passes the all-done case above while failing here.
test("a spent day counts every outcome, not just the ones that went well", () => {
  const p = payload([day("2026-08-24", "Monday", [
    sess({ status: "done" }),
    sess({ status: "missed" }),
    sess({ status: "missed" }),
    sess({ status: "skipped_by_design" }),
    sess({ status: "planned" }),
  ])], WEEK_META);
  const c = buildView(p, SGT("2026-08-26T09:00")).week.days[0].counts;

  assert.deepEqual(c, { total: 5, done: 1, missed: 2, skipped: 1, other: 1 });
  assert.notEqual(c.done, c.total, "a count that returned sessions.length would pass an all-done day");
});

test("an empty spent day is nothing planned, not zero done", () => {
  const p = payload([day("2026-08-24", "Monday", [])], WEEK_META);
  const c = buildView(p, SGT("2026-08-26T09:00")).week.days[0].counts;
  assert.equal(c.total, 0, "the renderer needs to tell a rest day from a day nobody completed");
  assert.equal(c.done, 0);
});

// 🔴 THE ONE PIECE OF ARITHMETIC IN THIS FILE THAT A UTC DATE GETS WRONG. Between midnight and
// 08:00 in Singapore it is still the previous day in UTC, so a classification built on
// `new Date(nowMs).getDate()` files today under "past" and shifts the whole week up one row --
// every morning, for eight hours, which is exactly when this app is read.
test("the past/today/ahead boundary is Singapore's midnight, not UTC's", () => {
  const p = payload([
    day("2026-08-24", "Monday", [sess({ status: "done" })]),
    day("2026-08-25", "Tuesday", [sess({ at: "2026-08-25T19:00" })]),
  ], WEEK_META);

  const justAfterMidnight = buildView(p, SGT("2026-08-25T00:05")).week;
  assert.deepEqual(justAfterMidnight.days.map((d) => d.phase), ["past", "today"]);

  const justBefore = buildView(p, SGT("2026-08-24T23:55")).week;
  assert.deepEqual(justBefore.days.map((d) => d.phase), ["today", "ahead"]);
});

// Four states share ONE dim treatment on screen, so the word is the only thing that separates
// them -- and the only carrier that survives a forced-colours mode. The mapping lives in view.js
// precisely so this test can exist: nothing in this suite renders the DOM, so a mapping kept in
// app.html could go missing with every test still green.
test("every status prints its own word, and a planned session prints none", () => {
  const p = payload([day("2026-08-25", "Tuesday", [
    sess({ status: "planned" }),
    sess({ status: "done" }),
    sess({ status: "missed" }),
    sess({ status: "skipped_by_design" }),
    sess({ status: "postponed_upstream" }),
  ])], WEEK_META);
  const words = buildView(p, SGT("2026-08-25T09:00")).week.days[0].sessions.map((s) => s.statusWord);

  assert.deepEqual(words, [null, "done", "missed", "skipped", "postponed upstream"]);
  assert.equal(new Set(words.slice(1)).size, 4, "no two states may share a word");
  assert.equal(words[4].includes("_"), false,
    "an unknown status still has to read as English -- `postponed_upstream` on screen is a name " +
    "that only makes sense once you know how the data is stored");
});

test("a week with no ceiling draws no bar at all, rather than a bar at zero", () => {
  const noCeiling = buildView(payload([day("2026-08-25", "Tuesday", [sess({})])], { plannedKm: 44.23 }), SGT("2026-08-25T09:00"));
  assert.equal(noCeiling.week.volume.plannedKm, 44.23);
  assert.equal(noCeiling.week.volume.fraction, null, "an unmeasured ceiling is an ABSENCE, never 0");
  assert.equal(noCeiling.week.volume.stepPct, null);

  const zeroCeiling = buildView(payload([day("2026-08-25", "Tuesday", [sess({})])], { plannedKm: 44.23, ceilingKm: 0 }), SGT("2026-08-25T09:00"));
  assert.equal(zeroCeiling.week.volume.fraction, null, "a zero ceiling must not divide");

  const full = buildView(payload([day("2026-08-25", "Tuesday", [sess({})])], WEEK_META), SGT("2026-08-25T09:00"));
  assert.equal(Math.round(full.week.volume.fraction * 1000) / 1000, 0.911);
  assert.equal(Math.round(full.week.volume.stepPct * 10) / 10, 9.3);
});

test("a day with no tag and no bed renders as a day, not as an empty slot", () => {
  const w = buildView(payload([day("2026-08-25", "Tuesday", [sess({})])], WEEK_META), SGT("2026-08-25T09:00")).week;
  assert.equal(w.days[0].tag, null);
  assert.equal(w.days[0].bed, null);
  assert.equal(w.daysToKiprun !== null, true);

  const noRace = buildView(payload([day("2026-08-25", "Tuesday", [sess({})])], {}), SGT("2026-08-25T09:00")).week;
  assert.equal(noRace.daysToKiprun, null, "no race date published means no countdown, not NaN");
});

// 🔴 THE ALLOWLIST REACHES ONE LEVEL DOWN, and it has to: `pick` does not recurse, so naming
// "bed" alone would copy every key the artifact ever adds to it. This is the direct analogue of
// the session-level check above, for the two structures this change introduced.
test("the day-level allowlist reaches inside bed, and drops what it does not name", () => {
  const out = reduceWeekState({
    meta: { weekLabel: "x", weekStart: "2026-08-24", weekEnd: "2026-08-30" },
    days: [{
      date: "2026-08-24", dow: "Monday", tag: "Long run", key: "mon", state: "past",
      bed: { plan: "22:15", kind: "Floor", text: "→ 6h00.", debtMinutes: 57, source: "garmin" },
      sessions: [{ kind: "k", title: "t", status: "planned", sport: "run", note: "<b>corrected</b>" }],
    }],
  }, { generatedAt: GEN });

  const d = out.days[0];
  assert.equal(d.tag, "Long run");
  assert.equal("key" in d, false, "a day field outside the allowlist must not be published");
  assert.equal("state" in d, false);
  assert.deepEqual(Object.keys(d.bed).sort(), ["kind", "plan", "text"]);
  assert.equal("debtMinutes" in d.bed, false, "the allowlist must reach INSIDE bed, not just name it");
  assert.equal("source" in d.bed, false);
  assert.equal(d.sessions[0].sport, "run");
  assert.equal("note" in d.sessions[0], false, "note carries raw markup and corrections; it is not published");
});

test("an empty bed is dropped rather than published as an empty object", () => {
  const out = reduceWeekState({
    meta: { weekLabel: "x", weekStart: "2026-08-24", weekEnd: "2026-08-30" },
    days: [
      { date: "2026-08-24", dow: "Monday", bed: { unknown: "x" }, sessions: [] },
      { date: "2026-08-25", dow: "Tuesday", bed: "22:15", sessions: [] },
    ],
  }, { generatedAt: GEN });
  assert.equal("bed" in out.days[0], false, "a bed with nothing allowlisted in it is an absent bed");
  assert.equal("bed" in out.days[1], false, "a bed that is not an object is not a bed");
});

// The mark set is closed, so an unknown sport is a MISSING ICON and not a broken week. Refusing
// the publish over it would take the whole plan off the screen to avoid omitting one glyph.
test("an unrecognised sport is dropped, and the session still publishes", () => {
  const out = reduceWeekState({
    meta: { weekLabel: "x", weekStart: "2026-08-24", weekEnd: "2026-08-30" },
    days: [{ date: "2026-08-24", dow: "Monday", sessions: [
      { kind: "k", title: "Swim", status: "planned", sport: "swim" },
      { kind: "k", title: "Ride", status: "planned", sport: "ride" },
    ] }],
  }, { generatedAt: GEN });
  assert.equal("sport" in out.days[0].sessions[0], false);
  assert.equal(out.days[0].sessions[0].title, "Swim", "the session survives losing its mark");
  assert.equal(out.days[0].sessions[1].sport, "ride");
});
