// The envelope this app hands to the Hermes box when a week is published.
//
// It is a SUMMARY, not the week. The reduced payload is already at the edge and the box cannot
// read it -- `calvin.sg` is deliberately absent from that box's egress allowlist, so nothing over
// there can fetch today.calvin.sg to fill in a gap. That cuts both ways: the envelope has to
// carry everything the notification says, and it must therefore carry NOTHING ELSE, because a
// field that is never rendered is a field shipped to a second system for no reason.
//
// Consumed by ~/bin/hermes-week-notify on that box, which composes the Telegram message and
// signs the same bytes for the gateway's webhook route. Changing a field name here is a
// two-machine change.

import { parseSgt } from "./view.js";

// ⚠️ THE APP'S OWN CLOCK, imported rather than re-derived. `at` and `leaveBy` are naive local ISO
// at a fixed +08:00 (CONTRACT.md, "Times and timezone"), and a second implementation of that
// here is a second thing that can be wrong about it.

/** The session the notification is actually about: the next one he has to leave the house for. */
export function nextActionable(payload, nowMs) {
  const found = [];
  for (const day of payload.days ?? []) {
    for (const s of day.sessions ?? []) {
      // 🔴 THREE CONDITIONS, and dropping any one of them announces the wrong thing.
      //   `at`      -- a session without one is a NOTE attached to a day (a kit list, a fuel
      //                plan, a wet-weather plan B). Six of twenty in one real week. Announcing
      //                "Next: Kit" would be worse than announcing nothing.
      //   `planned` -- `done`, `missed` and `skipped_by_design` are not things to leave for.
      //   in future -- a reconcile mid-week republishes the SAME week, so the payload is full of
      //                sessions already behind us.
      const startMs = parseSgt(s.at);
      // ⚠️ THE FIRST LINE IS A MEASURED NO-OP, KEPT ON PURPOSE, and saying so is cheaper than
      // letting someone discover it and write a test for behaviour that cannot differ. Deleting
      // it leaves the suite green: `null < nowMs` is `true` for any positive clock, because JS
      // coerces null to 0, so the line below already drops every note. That is an accident of
      // coercion and not a decision -- it stops being true the moment `nowMs` is passed as a
      // Date, and it states nothing about intent to the next reader. The mutation pass flagged
      // this as a survivor; it is listed as a no-op rather than papered over with an assertion.
      if (startMs === null) continue;
      if (s.status !== "planned") continue;
      if (startMs < nowMs) continue;
      found.push({ startMs, session: s });
    }
  }
  // The payload's day order is the week's order, but a day's sessions are not guaranteed sorted
  // and CONTRACT.md makes no promise about it -- so sort rather than take the first seen.
  found.sort((a, b) => a.startMs - b.startMs);
  return found.length ? found[0].session : null;
}

/**
 * One line of English naming the next session, pre-rendered HERE rather than in the webhook
 * route's prompt template.
 *
 * ⚠️ Hermes leaves an unresolved `{dot.notation}` key as the LITERAL STRING (webhooks.md, "Prompt
 * Templates"). So a template written as `{next.title}` puts the characters `{next.title}` into
 * the agent's prompt on any week with nothing left in it. One always-present field cannot do that.
 */
export function nextLine(next) {
  if (!next) return "There is nothing further this week that he has to leave the house for.";
  const parts = [`The next session he has to leave the house for is ${next.title}`];
  if (next.at) parts.push(` at ${next.at}`);
  if (next.leaveBy) parts.push(`, leaving by ${next.leaveBy}`);
  return `${parts.join("")}.`;
}

/**
 * @param {object} payload  the reduced week-state, exactly as written to KV
 * @param {number} nowMs    epoch ms; the publish moment
 */
export function buildEnvelope(payload, nowMs) {
  const meta = payload.meta ?? {};
  const days = payload.days ?? [];
  const next = nextActionable(payload, nowMs);

  return {
    // The route's `events` filter matches on this. A payload without it is answered 200
    // "ignored" rather than run, so it is not decoration.
    event_type: "week_published",
    week: {
      label: meta.weekLabel ?? "",
      start: meta.weekStart ?? "",
      end: meta.weekEnd ?? "",
    },
    counts: {
      days: days.length,
      sessions: days.reduce((n, d) => n + (d.sessions?.length ?? 0), 0),
    },
    // A NAMED SUBSET, never the session object. `pick`-by-hand for four fields: the artifact adds
    // fields without notice (CONTRACT.md's whole thesis), and spreading the session here would
    // ship every future one to the box the first week it appears.
    next: next
      ? {
          title: next.title,
          at: next.at ?? null,
          leaveBy: next.leaveBy ?? null,
          place: next.place ?? null,
        }
      : null,
    nextLine: nextLine(next),
    // Stamped by publish.mjs at reduce time, so the box reports the age of the WEEK rather than
    // the age of the message.
    generatedAt: payload.generatedAt ?? "",
  };
}
