// week-state (the artifact's 92 KB single source of truth) -> the small payload this app serves.
//
// The contract this reduces FROM is written down in CONTRACT.md, measured across three real
// artifacts. The short version, because it is the thing that breaks:
//
//   ALWAYS PRESENT: meta.weekLabel/weekStart/weekEnd, days[].date, days[].dow,
//                   days[].sessions[].kind/title/status.
//   EVERYTHING ELSE IS OPTIONAL, including `at`, `place` and `leaveBy`.
//
// `leaveBy` is the field this whole app is built around and it reads 13/20, 0/17 and 4/20 across
// the three artifacts. A renderer that assumes it exists is wrong on the first rest day. Absent
// fields are DROPPED here rather than emitted as null or "", so the app renders them as absent
// rather than as an empty row.

export const PAYLOAD_VERSION = 1;

// The fields the app is allowed to see. Anything not on this list never leaves the artifact --
// this is the allowlist, so a new field appearing upstream cannot silently start being published.
//
// `note` IS DELIBERATELY ABSENT and must stay absent. It fails on two independent grounds:
//   1. It carries RAW MARKUP. Two of the live week's six notes contain literal <b> tags, and this
//      app renders every field with textContent -- so they would arrive on screen as visible
//      angle brackets. CONTRACT.md refuses `spec` for exactly this reason; `note` is the same
//      field class and was missed when that list was written.
//   2. It is where the CORRECTIONS live -- "what was actually announced was 7:00/km", "recorded
//      as declined, not unavailable". This app shows the latest state of the plan and never the
//      history of how it got there.
// The `skipped_by_design` status word already says what the one genuinely useful note said.
export const SESSION_FIELDS = [
  "kind", "title", "status", "at", "until", "leaveBy",
  "place", "travel", "intention", "oneRule", "bring", "numbers", "sport",
];

// `sport` picks a MARK, and the mark set is closed -- calvin.sg ships a running figure and a
// cyclist and nothing else. An unrecognised value is therefore a missing icon, not a broken week,
// so it is DROPPED rather than refused: the session still renders, just without its mark.
const SPORTS = new Set(["run", "ride"]);

// The day, beyond its date. `tag` is the day's one-word character ("Banked", "Quality", "Long
// run") and `bed` is the night that closes it. Both are already emitted upstream and were being
// thrown away here.
export const DAY_FIELDS = ["dow", "tag", "bed"];

// 🔴 THE ALLOWLIST HAS TO REACH INSIDE `bed`, because `pick` DOES NOT RECURSE. Naming "bed" in
// DAY_FIELDS alone copies the whole object -- every key the artifact ever adds to it, published by
// accident, which is the one thing these lists exist to prevent.
export const BED_FIELDS = ["plan", "kind", "text"];

// From meta: what the app actually renders or reasons about, and nothing else.
// weekStart/weekEnd are here beyond the plan's list because they are what lets the app say
// "this plan does not cover today" instead of quietly showing nothing.
export const META_FIELDS = [
  "weekLabel", "weekStart", "weekEnd", "plannedKm", "ceilingKm", "priorWeekKm",
  "kiprunDate", "bydDate", "lastUpdated",
];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

class ContractError extends Error {}
export { ContractError };

function pick(source, fields) {
  const out = {};
  for (const f of fields) {
    const v = source[f];
    // Drop null/undefined/"" and empty arrays. Present-but-empty is indistinguishable from
    // absent to a reader, and carrying it costs bytes and invites `bring: []` rendering a
    // heading with nothing under it.
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[f] = v;
  }
  return out;
}

/**
 * @param {object} ws parsed #week-state
 * @param {{generatedAt: string}} opts ISO-8601 WITH offset -- the app does age arithmetic on it
 */
export function reduceWeekState(ws, { generatedAt }) {
  if (!ws || typeof ws !== "object") throw new ContractError("week-state is not an object");
  if (!ws.meta || typeof ws.meta !== "object") throw new ContractError("week-state has no meta");
  if (!Array.isArray(ws.days)) throw new ContractError("week-state has no days array");

  const meta = pick(ws.meta, META_FIELDS);
  for (const required of ["weekLabel", "weekStart", "weekEnd"]) {
    if (!meta[required]) throw new ContractError(`meta.${required} is missing`);
  }
  for (const d of ["weekStart", "weekEnd"]) {
    if (!ISO_DATE.test(meta[d])) throw new ContractError(`meta.${d} is not YYYY-MM-DD: ${meta[d]}`);
  }

  const days = [];
  for (const day of ws.days) {
    if (!day || typeof day !== "object") throw new ContractError("a day is not an object");
    if (!ISO_DATE.test(day.date ?? "")) throw new ContractError(`day.date is not YYYY-MM-DD: ${day.date}`);
    const sessions = [];
    for (const s of day.sessions ?? []) {
      if (typeof s?.kind !== "string" || typeof s?.title !== "string" || typeof s?.status !== "string") {
        throw new ContractError(`session on ${day.date} is missing kind/title/status`);
      }
      const session = pick(s, SESSION_FIELDS);
      if (session.sport !== undefined && !SPORTS.has(session.sport)) delete session.sport;
      sessions.push(session);
    }

    const rest = pick(day, DAY_FIELDS);
    // The nested allowlist. An empty result is DROPPED rather than emitted as `bed: {}` -- the
    // same rule `pick` applies one level up, for the same reason: a reader cannot tell an empty
    // object from an absent one, and carrying it invites rendering a heading with nothing under it.
    if (rest.bed !== undefined) {
      const bed = rest.bed && typeof rest.bed === "object" && !Array.isArray(rest.bed)
        ? pick(rest.bed, BED_FIELDS)
        : {};
      if (Object.keys(bed).length > 0) rest.bed = bed;
      else delete rest.bed;
    }

    // `dow` is always present in both artifacts, but deriving it here would be inventing a fact
    // the source states -- so carry it, and fall back only if it is genuinely absent. The default
    // is written BEFORE the spread so a stated `dow` always wins.
    days.push({ date: day.date, dow: "", ...rest, sessions });
  }

  return { v: PAYLOAD_VERSION, generatedAt, meta, days };
}
