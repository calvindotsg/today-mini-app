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
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { buildEnvelope, nextActionable, nextLine } from "../src/notify.js";
import { reduceWeekState } from "../src/reduce.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLISH = join(ROOT, "scripts", "publish.mjs");
const TMP = mkdtempSync(join(tmpdir(), "notify-test-"));

// 🔴 SET ONCE, FOR THE WHOLE FILE, so a spawn that builds its own env cannot leak.
// Every `spawnSync(..., { env: { ...process.env, ... } })` inherits this, which is the point:
// the first version redirected the archive inside one helper only, and a test that assembled
// its own env promptly wrote two fixture files into the operator's real
// ~/.local/state/today-mini-app/published. Same shape as the incident this whole archive exists
// for — a guard that covered the path everyone remembered and not the one nobody did.
process.env.TODAY_ARCHIVE_DIR = join(TMP, "archive");
// See test/publish.test.mjs for why dist/ is redirected as well: the two files run concurrently
// and were racing over the operator's only recovery copy of a published week.
process.env.TODAY_DIST_DIR = join(TMP, "dist");

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
  // 🔴 THE ARCHIVE IS REDIRECTED, not just the PATH. `npx` is shimmed to SUCCEED here, so the
  // publisher believes the KV write worked and goes on to write its durable copy. Without this
  // every --put test would deposit a fixture in Calvin's real ~/.local/state archive — the exact
  // shape of defect that put a fixture in production KV in the first place.
  const archive = join(TMP, `${name}-archive`);
  const r = spawnSync(process.execPath, [PUBLISH, file, ...args], {
    encoding: "utf8", cwd: ROOT,
    env: {
      ...process.env,
      PATH: `${dir}${delimiter}${process.env.PATH}`,
      TODAY_ARCHIVE_DIR: archive,
    },
  });
  const envelopeFile = join(process.env.TODAY_DIST_DIR, "envelope.json");
  return {
    code: r.status, out: r.stdout ?? "", err: r.stderr ?? "",
    sent: existsSync(record) ? JSON.parse(readFileSync(record, "utf8")) : null,
    envelopeFile,
    wrote: existsSync(envelopeFile) ? JSON.parse(readFileSync(envelopeFile, "utf8")) : null,
    archive,
    archived: existsSync(archive)
      ? readdirSync(archive).filter((f) => f.endsWith(".json")).sort()
      : [],
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

// ── the envelope as a FILE, which is the whole autonomous path ───────────────────────────────
//
// 📌 NEGATIVE CONTROLS, RUN AND RECORDED 2026-09-02 rather than run and discarded. This repo has
// no mutation driver, so each guard below was put back the way it was by hand and the file re-run:
//
//   remove the `writeFileSync(.../envelope.json)`      -> 3 red
//   add a second `buildEnvelope(...)` call site        -> 1 red (the call-site assertion)
//   make DIST_DIR ignore TODAY_DIST_DIR                -> 3 red
//   point the suite's TODAY_DIST_DIR at the real dist/ -> 1 red (the redirect assertion)
//
// All four caught, subject restored, 27/27 green afterwards. A guard nobody has broken on purpose
// is a claim, not evidence.
//
// 🔴 `training-week-publish` runs this publisher WITH NO FLAGS and never reaches the notify leg,
// so before 2026-09-02 buildEnvelope was unreachable on the only path that publishes unattended
// and a week arrived on the phone with nothing announcing it. The routine now copies this file
// into the private wiki as `announce/<stem>.json`, and a timer on the Hermes box reads it
// verbatim — that box has no node and could not build one itself.
test("a run with no flags still writes the envelope, because that is the unattended path", () => {
  const r = run("envelope-dry", []);
  assert.equal(r.code, 0);
  assert.equal(r.sent, null, "and it still sends nothing");
  assert.ok(r.wrote, "dist/envelope.json must exist after a no-flag run");
  assert.equal(r.wrote.event_type, "week_published");
  assert.equal(r.wrote.week.start, "2026-08-31");
  assert.equal(r.wrote.next.title, "6 km with Bryan");
  assert.match(r.out, /wrote {5}.*envelope\.json/);
});

// 🔴 THE PROPERTY THAT MAKES THE FILE EVIDENCE: what is committed is what gets said. Built once
// and handed to both consumers, so the record of the announcement cannot drift from the
// announcement — not by a clock tick, and not by a second code path added later.
test("the envelope on disk is byte-identical to the one piped to the notifier", () => {
  const r = run("envelope-same", ["--put"]);
  assert.equal(r.code, 0);
  assert.ok(r.wrote && r.sent);
  assert.deepEqual(r.wrote, r.sent);
});

// ⚠️ THE TEST ABOVE ASSERTS CONSISTENCY, NOT SINGLE-BUILD, and saying so is cheaper than letting
// someone read it as the stronger claim. Re-adding a second `buildEnvelope(payload, Date.now())`
// in the notify leg leaves it GREEN: every field of this fixture is stable across two clock
// reads, so the two objects would still deep-equal. Measured, not assumed. The single-build
// property has to be asserted where it lives — one call site in the publisher — which is
// mechanical and does bite.
test("the publisher builds the envelope exactly once", () => {
  const src = readFileSync(PUBLISH, "utf8");
  const calls = src.match(/buildEnvelope\(/g) ?? [];
  assert.equal(calls.length, 1,
    "two build sites let the committed record of what was announced drift from what was sent");
});

// It is a SUMMARY, and the boundary it crosses is a machine boundary. A field nobody renders is
// a field shipped to a second system for no reason — asserted on the file, not just on the
// function, because the file is what now travels.
test("the envelope file carries the summary and not the week", () => {
  const r = run("envelope-shape", []);
  assert.deepEqual(Object.keys(r.wrote).sort(),
    ["counts", "event_type", "generatedAt", "next", "nextLine", "week"]);
  assert.equal(r.wrote.days, undefined, "the days never travel");
  assert.deepEqual(Object.keys(r.wrote.next).sort(), ["at", "leaveBy", "place", "title"]);
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

// ── the durable archive ──────────────────────────────────────────────────────────────────────
//
// dist/payload.json was the only copy of a real week on 2026-09-02 and the next test run erased
// it. These prove the replacement is written on a real publish, only then, and nowhere near the
// operator's own archive while the suite runs.

// ⚠️ THE REDIRECT ASSERTION FIRST. If TODAY_ARCHIVE_DIR were ignored, every case below would
// still pass while quietly writing fixtures into ~/.local/state — a suite that looks green and
// is corrupting the thing it is protecting.
// 🔴 THE GUARD THAT WOULD HAVE CAUGHT THE LEAK. The per-helper redirect was correct and
// insufficient: the ssh-leg test below assembles its own env, inherited the default archive path,
// and wrote two fixture files into the real ~/.local/state/today-mini-app/published. An assertion
// about ONE call site cannot see that. This one is about the whole file — every spawn of the
// publisher in this suite must be pointed somewhere disposable, whoever wrote the spawn.
test("no spawn in this file can reach the operator's real archive", () => {
  const src = readFileSync(new URL(import.meta.url), "utf8");
  const spawns = [...src.matchAll(/spawnSync\(process\.execPath, \[PUBLISH[\s\S]{0,600}?\}\);/g)]
    .map((m) => m[0]);
  assert.ok(spawns.length >= 3, `expected several publisher spawns, found ${spawns.length}`);
  for (const call of spawns) {
    const inheritsEnv = /\.\.\.process\.env/.test(call);
    const setsArchive = /TODAY_ARCHIVE_DIR/.test(call);
    assert.ok(inheritsEnv || setsArchive,
      `a publisher spawn neither inherits process.env (which carries the file-wide redirect) ` +
      `nor sets TODAY_ARCHIVE_DIR itself:\n${call.slice(0, 200)}`);
  }
  // And the redirect itself must not be the real path, or inheriting it proves nothing.
  assert.ok(process.env.TODAY_ARCHIVE_DIR?.startsWith(TMP));
  assert.doesNotMatch(process.env.TODAY_ARCHIVE_DIR, /\.local[/\\]state/);
  // Same question for dist/, which every run writes whether or not it publishes.
  assert.ok(process.env.TODAY_DIST_DIR?.startsWith(TMP));
  assert.doesNotMatch(process.env.TODAY_DIST_DIR, new RegExp(`^${ROOT}`));
});

test("the suite's archive is not the operator's archive", () => {
  const r = run("redirect", ["--put"]);
  assert.equal(r.code, 0);
  assert.ok(r.archive.startsWith(TMP), "the archive must be inside the test's temp dir");
  assert.doesNotMatch(r.archive, /\.local[/\\]state/, "and must not be the real state path");
  assert.equal(r.archived.length, 1, "and the redirect must have actually received the write");
});

test("a real publish leaves a durable copy, named so it sorts by week", () => {
  const r = run("archived", ["--put"]);
  assert.equal(r.archived.length, 1);
  assert.match(r.archived[0], /^2026-08-31--/, "the week it covers leads the name");
  assert.match(r.out, /archived {2}/, "and the publisher says where it went");
  const saved = JSON.parse(readFileSync(join(r.archive, r.archived[0]), "utf8"));
  assert.equal(saved.meta.weekStart, "2026-08-31", "the archive is the published payload itself");
});

// 🔴 THE CASE THE INCIDENT WAS. A dry run must leave no archive at all, or the archive fills with
// rehearsals and the newest file stops meaning "what the edge is serving".
test("a run without --put archives nothing", () => {
  const r = run("dry-archive", []);
  assert.equal(r.archived.length, 0);
});

test("a failed notification still leaves the archive, because the week did publish", () => {
  const r = run("archive-notify-fail", ["--put"], 3);
  assert.equal(r.code, 3);
  assert.equal(r.archived.length, 1, "the KV write succeeded, so the copy must exist");
});

// An archive that grows without bound is a different problem, not a solution.
test("the archive keeps a bounded number of copies", () => {
  const { dir } = shimBin("prune", 0);
  const archive = join(TMP, "prune-archive");
  spawnSync("mkdir", ["-p", archive]);
  for (let i = 0; i < 20; i++) writeFileSync(join(archive, `2026-01-${String(i + 1).padStart(2, "0")}--x.json`), "{}");
  const file = join(TMP, "prune.json");
  writeFileSync(file, JSON.stringify({
    meta: { weekLabel: "W36", weekStart: "2026-08-31", weekEnd: "2026-09-06" },
    days: [{ date: "2026-08-31", dow: "Monday", sessions: [
      { kind: "Run", title: "x", status: "planned", at: "2099-08-31T18:43" }] }],
  }));
  spawnSync(process.execPath, [PUBLISH, file, "--put", "--no-notify"], {
    encoding: "utf8", cwd: ROOT,
    env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}`, TODAY_ARCHIVE_DIR: archive },
  });
  const kept = readdirSync(archive).filter((f) => f.endsWith(".json"));
  assert.equal(kept.length, 12, "older copies are pruned to the cap");
  assert.ok(kept.some((f) => f.startsWith("2026-08-31--")), "and the newest one survives");
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
