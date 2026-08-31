// week-state (the artifact's 92 KB single source of truth) -> the small payload this app serves.
//
// The contract this reduces FROM is written down in CONTRACT.md, measured across two real
// artifacts. The short version, because it is the thing that breaks:
//
//   ALWAYS PRESENT: meta.weekLabel/weekStart/weekEnd, days[].date, days[].dow,
//                   days[].sessions[].kind/title/status.
//   EVERYTHING ELSE IS OPTIONAL, including `at`, `place` and `leaveBy`.
//
// `leaveBy` is the field this whole app is built around and it is present on 13 of 20 sessions in
// one artifact and 0 of 17 in the other. A renderer that assumes it exists is wrong on the first
// rest day. Absent fields are DROPPED here rather than emitted as null or "", so the app renders
// them as absent rather than as an empty row.

export const PAYLOAD_VERSION = 1;

// The fields the app is allowed to see. Anything not on this list never leaves the artifact --
// this is the allowlist, so a new field appearing upstream cannot silently start being published.
export const SESSION_FIELDS = [
  "kind", "title", "status", "at", "until", "leaveBy",
  "place", "travel", "intention", "oneRule", "bring", "numbers",
];

// From meta: what the app actually renders or reasons about, and nothing else.
// weekStart/weekEnd are here beyond the plan's list because they are what lets the app say
// "this plan does not cover today" instead of quietly showing nothing.
export const META_FIELDS = [
  "weekLabel", "weekStart", "weekEnd", "plannedKm", "ceilingKm", "kiprunDate", "bydDate", "lastUpdated",
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
      sessions.push(pick(s, SESSION_FIELDS));
    }
    // `dow` is always present in both artifacts, but deriving it here would be inventing a fact
    // the source states -- so carry it, and fall back only if it is genuinely absent.
    days.push({ date: day.date, dow: day.dow ?? "", sessions });
  }

  return { v: PAYLOAD_VERSION, generatedAt, meta, days };
}
