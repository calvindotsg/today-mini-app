// The payload -> what the one screen shows. Pure, no DOM, no network: everything the app is
// allowed to decide is decided here, so it can be tested without a browser.
//
// WHY THE WORKER DOES THIS AND NOT THE APP. The publisher runs on demand -- a Claude session
// pushes when the week's plan is written or revised, which is roughly weekly. So the payload
// carries the WHOLE week and the slice to "today and the next two days" happens per request,
// against the request's own clock. A slice baked in at publish time would be right on the day it
// was pushed and wrong every day after.
//
// SINGAPORE TIME, AS A FIXED +08:00. The artifact writes `at`/`leaveBy` as naive local ISO
// ("2026-08-28T18:30") with no offset, and Singapore has had no DST since 1982 and no offset
// change since 1982-01-01. So a fixed offset is exact here, not an approximation -- and it keeps
// this file free of a timezone database it would otherwise need on two different runtimes.

export const SGT_OFFSET_MINUTES = 8 * 60;

// The plan is only ever ACTED on. A session already done, missed, or skipped on purpose is not
// something to leave the house for, so it never occupies the Now or Next slot. It is still in
// the payload -- this is a display rule, not a filter on the data.
const ACTIONABLE = new Set(["planned"]);

export const STALE_AFTER_HOURS = 18;

function sgtNow(nowMs) {
  return new Date(nowMs + SGT_OFFSET_MINUTES * 60_000);
}

/** YYYY-MM-DD for the given instant, in Singapore time. */
export function sgtDate(nowMs) {
  return sgtNow(nowMs).toISOString().slice(0, 10);
}

/** A naive local ISO ("2026-08-28T18:30") -> epoch ms, read as Singapore time. */
export function parseSgt(naive) {
  if (typeof naive !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(naive);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  return Date.UTC(+y, +mo - 1, +d, +h, +mi) - SGT_OFFSET_MINUTES * 60_000;
}

function addDays(isoDate, n) {
  const t = Date.parse(`${isoDate}T00:00:00Z`);
  return new Date(t + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * @param {object|null} payload as produced by reduce.js, or null when KV holds nothing
 * @param {number} nowMs
 * @returns view model. `ok:false` is an HONEST error state, and the app renders it as one --
 *          never as a blank screen, which is indistinguishable from a page that failed to load.
 */
export function buildView(payload, nowMs) {
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "No plan has been published yet." };
  }
  if (payload.v !== 1) {
    // The contract is owned elsewhere -- by the Claude project that writes the artifact -- so it
    // can change without warning. Failing visibly is the requirement; rendering whatever happens
    // to parse is how a page shows nonsense with a straight face.
    return { ok: false, error: "This plan was published in a format this app does not understand." };
  }
  const meta = payload.meta ?? {};
  const days = Array.isArray(payload.days) ? payload.days : [];

  const today = sgtDate(nowMs);
  const generatedMs = Date.parse(payload.generatedAt ?? "");
  const ageHours = Number.isFinite(generatedMs) ? (nowMs - generatedMs) / 3_600_000 : null;

  const view = {
    ok: true,
    weekLabel: meta.weekLabel ?? "",
    today,
    generatedAt: payload.generatedAt ?? null,
    ageHours,
    stale: ageHours === null || ageHours > STALE_AFTER_HOURS,
    // Two DIFFERENT kinds of out-of-date, and conflating them would hide the worse one. `stale`
    // says the push is old; `coversToday` says the plan itself is for another week. A plan
    // published an hour ago for last week is fresh AND useless.
    coversToday: Boolean(meta.weekStart && meta.weekEnd && today >= meta.weekStart && today <= meta.weekEnd),
    weekStart: meta.weekStart ?? null,
    weekEnd: meta.weekEnd ?? null,
    plannedKm: meta.plannedKm ?? null,
    ceilingKm: meta.ceilingKm ?? null,
    now: null,
    next: null,
    laterCount: 0,
    emptyReason: null,
  };

  // Today and the next two days, by date -- not by position, because a payload is not required
  // to hold seven days and gaps are legal.
  const window = new Set([today, addDays(today, 1), addDays(today, 2)]);
  const upcoming = [];
  for (const day of days) {
    if (!window.has(day.date)) continue;
    for (const s of day.sessions ?? []) {
      if (!ACTIONABLE.has(s.status)) continue;
      upcoming.push({ ...s, date: day.date, dow: day.dow ?? "", startMs: parseSgt(s.at) });
    }
  }

  // Order: by day, then by start time where there is one, then by the order the artifact wrote
  // them. Sessions with no `at` are notes attached to a day ("Kit · what you are carrying"), not
  // appointments, so they sort AFTER the timed ones on the same day rather than being dropped.
  upcoming.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.startMs !== null && b.startMs !== null) return a.startMs - b.startMs;
    if (a.startMs === null && b.startMs !== null) return 1;
    if (a.startMs !== null && b.startMs === null) return -1;
    return 0;
  });

  // A session that has already started today is behind you. Untimed ones are never "past".
  const ahead = upcoming.filter((s) => s.startMs === null || s.startMs >= nowMs);

  view.now = ahead[0] ?? null;
  view.next = ahead[1] ?? null;
  view.laterCount = Math.max(0, ahead.length - 2);

  if (!view.now) {
    if (days.length === 0) view.emptyReason = "empty";
    else if (!view.coversToday) view.emptyReason = "other-week";
    else view.emptyReason = "nothing-left";
  }
  return view;
}
