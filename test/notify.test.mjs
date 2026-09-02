// The publish-time notification: the envelope, and the wiring that sends it.
//
// The wiring half runs the REAL `--put` path with `npx` and `ssh` shimmed onto PATH. Asserting it
// with a source grep was the alternative and it is the weaker one -- a grep passes on code that is
// never reached, which is precisely the failure this notification exists to prevent elsewhere in
// this repo. The shims mean the publisher genuinely spawns something, genuinely pipes the envelope
// into it, and genuinely reads its exit code; only the far end is fake.
//
// ⚠️ NOTHING HERE TOUCHES KV OR THE BOX. `npx` is a no-op and `ssh` never leaves the temp dir.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { buildEnvelope, nextActionable, nextLine } from "../src/notify.js";
import { reduceWeekState } from "../src/reduce.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLISH = join(ROOT, "scripts", "publish.mjs");
const TMP = mkdtempSync(join(tmpdir(), "notify-test-"));

const SGT = (naive) => Date.parse(`${naive}+08:00`);

function sess(o = {}) {
  return { kind: "Run", title: "a run", status: "planned", ...o };
}
function payload(days, meta = {}) {
  return reduceWeekState(
    {
      meta: { weekLabel: "W36", weekStart: "2026-08-31", weekEnd: "2026-09-06", ...meta },
      days,
    },
    { generatedAt: "2026-09-02T11:00:00+08:00" },
  );
}
const day = (date, dow, sessions) => ({ date, dow, sessions });

// ── nextActionable: the three conditions ─────────────────────────────────────────────────────

test("the next session is the next TIMED, PLANNED one still ahead", () => {
  const p = payload([day("2026-09-02", "Wednesday", [
    sess({ title: "already done", at: "2026-09-02T06:00", status: "done" }),
    sess({ title: "the one", at: "2026-09-02T18:30", leaveBy: "2026-09-02T17:45" }),
    sess({ title: "later still", at: "2026-09-02T20:00" }),
  ])]);
  assert.equal(nextActionable(p, SGT("2026-09-02T11:00")).title, "the one");
});

// 🔴 Six of twenty sessions in one real week had no `at`: kit lists, fuel plans, a wet-weather
// plan B. They are content, and they are not appointments -- announcing "Next: Kit" would be
// worse than announcing nothing at all.
test("a session with no clock is a note, and is never announced", () => {
  const p = payload([day("2026-09-02", "Wednesday", [
    sess({ title: "Kit · what you are carrying", kind: "Kit" }),
    sess({ title: "the real one", at: "2026-09-02T18:30" }),
  ])]);
  assert.equal(nextActionable(p, SGT("2026-09-02T11:00")).title, "the real one");
});

test("only `planned` is something to leave the house for", () => {
  for (const status of ["done", "missed", "skipped_by_design"]) {
    const p = payload([day("2026-09-02", "Wednesday", [sess({ title: "x", at: "2026-09-02T18:30", status })])]);
    assert.equal(nextActionable(p, SGT("2026-09-02T11:00")), null, `${status} must not be announced`);
  }
});

// A mid-week reconcile republishes the SAME week, so the payload is mostly behind us.
test("a session already past is not the next one", () => {
  const p = payload([day("2026-09-02", "Wednesday", [sess({ title: "this morning", at: "2026-09-02T06:00" })])]);
  assert.equal(nextActionable(p, SGT("2026-09-02T11:00")), null);
});

test("sessions are ordered by clock, not by their position in the day", () => {
  const p = payload([day("2026-09-02", "Wednesday", [
    sess({ title: "evening", at: "2026-09-02T19:00" }),
    sess({ title: "afternoon", at: "2026-09-02T14:00" }),
  ])]);
  assert.equal(nextActionable(p, SGT("2026-09-02T11:00")).title, "afternoon");
});

// ── nextLine: the field that cannot be missing ───────────────────────────────────────────────
//
// ⚠️ Hermes leaves an unresolved {dot.notation} key as the LITERAL STRING. `nextLine` exists so
// the route's prompt template has no key that can come out as `{next.title}` in the agent's face.
test("nextLine always says something, including when there is nothing left", () => {
  assert.match(nextLine(null), /nothing further this week/);
  assert.match(nextLine({ title: "ARC run", at: "2026-09-03T18:30", leaveBy: "2026-09-03T17:45" }),
    /ARC run at 2026-09-03T18:30, leaving by 17:45|ARC run at 2026-09-03T18:30, leaving by 2026-09-03T17:45/);
  // A session with a start and no leaveBy reads 13/20, 0/17 and 4/20 across three real artifacts.
  assert.match(nextLine({ title: "ARC run", at: "2026-09-03T18:30" }), /ARC run at 2026-09-03T18:30\.$/);
});

// ── buildEnvelope: a named subset, and nothing else ──────────────────────────────────────────

test("the envelope carries the week, the counts and one session — and no more", () => {
  const p = payload([
    day("2026-09-02", "Wednesday", [sess({ title: "ARC run", at: "2026-09-02T18:30", leaveBy: "2026-09-02T17:45", place: "the park" })]),
    day("2026-09-03", "Thursday", [sess({ title: "rest", kind: "Rest" })]),
  ]);
  const e = buildEnvelope(p, SGT("2026-09-02T11:00"));

  assert.deepEqual(Object.keys(e).sort(),
    ["counts", "event_type", "generatedAt", "next", "nextLine", "week"]);
  assert.equal(e.event_type, "week_published", "the route filters on this");
  assert.deepEqual(e.week, { label: "W36", start: "2026-08-31", end: "2026-09-06" });
  assert.deepEqual(e.counts, { days: 2, sessions: 2 });
  assert.deepEqual(Object.keys(e.next).sort(), ["at", "leaveBy", "place", "title"]);
  assert.equal(e.generatedAt, "2026-09-02T11:00:00+08:00");
});

// 🔴 The reason `next` is picked field by field rather than spread. CONTRACT.md's whole thesis is
// that the artifact grows fields without notice; a spread would ship each new one to a second
// machine the first week it appeared, silently.
test("an unknown session field is not forwarded to the box", () => {
  const p = payload([day("2026-09-02", "Wednesday", [
    sess({ title: "ARC run", at: "2026-09-02T18:30", oneRule: "hold the pace", intention: "steady" }),
  ])]);
  const e = buildEnvelope(p, SGT("2026-09-02T11:00"));
  assert.equal("oneRule" in e.next, false);
  assert.equal("intention" in e.next, false);
  assert.equal(JSON.stringify(e).includes("hold the pace"), false);
});

test("a week with nothing ahead still produces a valid envelope", () => {
  const p = payload([day("2026-09-02", "Wednesday", [sess({ title: "done", at: "2026-09-02T06:00", status: "done" })])]);
  const e = buildEnvelope(p, SGT("2026-09-02T23:00"));
  assert.equal(e.next, null);
  assert.equal(e.event_type, "week_published");
  assert.match(e.nextLine, /nothing further/);
});

// ── the wiring ───────────────────────────────────────────────────────────────────────────────

/** A PATH holding a no-op `npx` and an `ssh` that records its stdin and exits `sshExit`. */
function shimBin(name, sshExit) {
  const dir = join(TMP, name);
  const record = join(dir, "stdin.json");
  spawnSync("mkdir", ["-p", dir]);
  writeFileSync(join(dir, "npx"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(dir, "ssh"),
    `#!/bin/sh\ncat > ${record}\necho "telegram  message_id=1 entities=[] buttons=2"\nexit ${sshExit}\n`);
  chmodSync(join(dir, "npx"), 0o755);
  chmodSync(join(dir, "ssh"), 0o755);
  return { dir, record };
}

function run(name, args, sshExit = 0) {
  const { dir, record } = shimBin(name, sshExit);
  const file = join(TMP, `${name}.json`);
  writeFileSync(file, JSON.stringify({
    meta: { weekLabel: "W36", weekStart: "2026-08-31", weekEnd: "2026-09-06" },
    days: [{ date: "2026-08-31", dow: "Monday", sessions: [
      { kind: "Run", title: "6 km with Bryan", status: "planned", at: "2099-08-31T18:43" },
    ] }],
  }));
  const r = spawnSync(process.execPath, [PUBLISH, file, ...args], {
    encoding: "utf8", cwd: ROOT,
    env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}` },
  });
  return {
    code: r.status, out: r.stdout ?? "", err: r.stderr ?? "",
    sent: existsSync(record) ? JSON.parse(readFileSync(record, "utf8")) : null,
  };
}

// ⚠️ THE GATE THAT MATTERS MOST. `publish.mjs <file>` with no --put is the command the weekly
// skill runs as a dry check before the artifact is finished. If that rehearsal announced a week
// in Telegram, the check would be unusable.
test("a run without --put sends nothing", () => {
  const r = run("dry", []);
  assert.equal(r.code, 0);
  assert.equal(r.sent, null, "no ssh may be spawned at all");
  assert.match(r.out, /not published/);
});

test("--put sends the envelope on the notifier's stdin", () => {
  const r = run("put", ["--put"]);
  assert.equal(r.code, 0);
  assert.ok(r.sent, "the notifier must have been spawned and piped to");
  assert.equal(r.sent.event_type, "week_published");
  assert.equal(r.sent.week.start, "2026-08-31");
  assert.equal(r.sent.next.title, "6 km with Bryan");
  assert.match(r.out, /notify {4}sent/);
});

test("--no-notify publishes and says plainly that nothing was sent", () => {
  const r = run("quiet", ["--put", "--no-notify"]);
  assert.equal(r.code, 0);
  assert.equal(r.sent, null);
  assert.match(r.out, /published to the edge/);
  assert.match(r.out, /Nothing has been sent to Telegram/);
});

// 🔴 The whole point of the split. The week is at the edge in every one of these; only the
// message failed. Exit 1 would say the publish failed, and the operator would republish.
test("a failed notification exits 3, and the publish still reports as done", () => {
  const r = run("fail3", ["--put"], 3);
  assert.equal(r.code, 3, "not 1 — the week published fine");
  assert.match(r.out, /published to the edge/, "the successful publish must still be on stdout");
  assert.match(r.err, /NOT NOTIFIED/);
});

// The two failures are not the same mistake to make, because sendMessage has no idempotency.
test("exit 4 from the box means the message went, and says not to re-run", () => {
  const r = run("fail4", ["--put"], 4);
  assert.equal(r.code, 3);
  assert.match(r.err, /Do NOT re-run/);
  assert.doesNotMatch(r.err, /re-running is safe/);
});

test("exit 3 from the box means nothing was sent, and says re-running is safe", () => {
  const r = run("fail3b", ["--put"], 3);
  assert.match(r.err, /re-running is safe/);
  assert.doesNotMatch(r.err, /Do NOT re-run/);
});

// 🔴 THE SSH LEG, PROVEN INDEPENDENTLY. The incident on 2026-09-02 reached production TWICE: the
// KV write, and then six real Telegram messages through `ssh ssh-hermes bin/hermes-week-notify`.
// The first reproduction of it only proved the `npx` shim, because npx refuses FIRST and the
// publisher dies before the ssh call -- so the ssh leg was bounded only transitively, which is a
// claim about ordering rather than about the sandbox. Here npx SUCCEEDS, so execution genuinely
// arrives at the ssh call, and the refusal has to come from the ssh shim itself.
test("even when the KV write succeeds, the notifier cannot reach the box", () => {
  const dir = join(TMP, "ssh-leg");
  spawnSync("mkdir", ["-p", dir]);
  writeFileSync(join(dir, "npx"), "#!/bin/sh\nexit 0\n");                       // the write "works"
  writeFileSync(join(dir, "ssh"), "#!/bin/sh\necho REFUSED-SSH >&2\nexit 97\n"); // the box does not
  chmodSync(join(dir, "npx"), 0o755);
  chmodSync(join(dir, "ssh"), 0o755);

  const file = join(TMP, "ssh-leg.json");
  writeFileSync(file, JSON.stringify({
    meta: { weekLabel: "W36", weekStart: "2026-08-31", weekEnd: "2026-09-06" },
    days: [{ date: "2026-08-31", dow: "Monday", sessions: [
      { kind: "Run", title: "probe", status: "planned", at: "2099-08-31T18:43" }] }],
  }));
  const r = spawnSync(process.execPath, [PUBLISH, file, "--put"], {
    encoding: "utf8", cwd: ROOT,
    env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}` },
  });

  assert.match(r.stdout, /published to the edge/, "the KV write must have been allowed through");
  assert.match(r.stderr, /REFUSED-SSH/, "and the ssh leg must be refused by the shim, not by ordering");
  assert.equal(r.status, 3, "a refused notification is exit 3, never a failed publish");
});

test("an unreachable box is not reported as either half", () => {
  const r = run("fail255", ["--put"], 255);
  assert.equal(r.code, 3);
  assert.match(r.err, /did not get far enough/);
  assert.match(r.err, /ssh ssh-hermes true/);
});
