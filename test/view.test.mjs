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

test("a session already under way is behind you and never occupies Now", () => {
  const p = payload([day("2026-08-24", "Monday", [
    sess({ title: "Morning", at: "2026-08-24T06:15" }),
    sess({ title: "Evening", at: "2026-08-24T18:00" }),
  ])]);
  const v = buildView(p, SGT("2026-08-24T12:00"));
  assert.equal(v.now.title, "Evening");
  assert.equal(v.next, null);
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
