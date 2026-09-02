// The publisher's CONTENT gates, exercised by running the publisher.
//
// Two rules this app makes about what reaches the screen used to live only in prose, in a document
// the app never reads -- and a prose requirement lapses silently, which is the exact failure that
// put a week on the edge with no #week-state block at all. They are commands now, and these are
// the tests that keep them commands.
//
// SPAWNED RATHER THAN IMPORTED, because scripts/publish.mjs is a CLI: it reads argv and calls
// process.exit, so importing it would run it. What is asserted is what the operator actually sees
// -- the exit code and the stream the message lands on.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxEnv } from "./helpers.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLISH = join(ROOT, "scripts", "publish.mjs");
const TMP = mkdtempSync(join(tmpdir(), "publish-test-"));

// 🔴 SET ONCE, FOR THE WHOLE FILE, so a spawn that builds its own env cannot leak.
// Every `spawnSync(..., { env: { ...process.env, ... } })` inherits this, which is the point:
// the first version redirected the archive inside one helper only, and a test that assembled
// its own env promptly wrote two fixture files into the operator's real
// ~/.local/state/today-mini-app/published. Same shape as the incident this whole archive exists
// for — a guard that covered the path everyone remembered and not the one nobody did.
process.env.TODAY_ARCHIVE_DIR = join(TMP, "archive");

/** A minimal week that reduces cleanly, so each test changes exactly one thing about it. */
function weekState(overrides = {}) {
  return {
    meta: {
      weekLabel: "Week of 31 August – 6 September 2026",
      weekStart: "2026-08-31", weekEnd: "2026-09-06",
      plannedKm: 44.23, ceilingKm: 48.57,
    },
    days: [{
      date: "2026-08-31", dow: "Monday", tag: "Banked",
      bed: { plan: "23:15", kind: "Optional", text: "→ 6h00. Nothing depends on this." },
      sessions: [{
        kind: "Run · 18:43", title: "6 km with Bryan", status: "planned",
        at: "2026-08-31T18:43", oneRule: "Hold the announced pace.", sport: "run",
      }],
    }],
    ...overrides,
  };
}

function publish(ws, name) {
  const file = join(TMP, `${name}.json`);
  writeFileSync(file, JSON.stringify(ws));
  // No --put: nothing is written anywhere but dist/payload.json.
  //
  // 🔴 AND THE ENVIRONMENT ENFORCES THAT, because the flag alone did not. On 2026-09-02 a mutation
  // removed the `process.exit(0)` from `publish.mjs`'s `if (!put)` block; these tests fell straight
  // through to the real `npx wrangler kv key put` and published this fixture over the live week.
  // `sandboxEnv` puts refusing shims for `npx`, `ssh` and `wrangler` in front of PATH, so the
  // reachability of production is decided HERE and not by whatever the source happens to say.
  const r = spawnSync(process.execPath, [PUBLISH, file], {
    encoding: "utf8", cwd: ROOT, env: sandboxEnv(join(TMP, "bin")),
  });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

// The control for the control. A sandbox nobody exercises is a sandbox nobody knows is wired --
// this proves the shims are actually in front of PATH for the command these tests spawn.
test("a spawned publisher cannot reach wrangler or the box", () => {
  const r = spawnSync(process.execPath, ["-e", "require('child_process').execFileSync('npx',['--version'],{stdio:'inherit'})"],
    { encoding: "utf8", cwd: ROOT, env: sandboxEnv(join(TMP, "bin")) });
  assert.equal(r.status, 1, "the shim must make npx fail rather than run");
  assert.match(r.stderr, /REFUSED: a test invoked `npx`/,
    "and it must say what it refused, so a fall-through is legible rather than silent");
});

test("a clean week publishes, and says what kinds of night it carries", () => {
  const r = publish(weekState(), "clean");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /1 days, 1 sessions/);
  // Drift in the bedtime vocabulary is visible HERE or nowhere: `bed.kind` is printed verbatim by
  // the app, so an artifact that renames "Gate" would otherwise change nothing that reports.
  assert.match(r.out, /bedtimes\s+1\/1 nights stated — Optional/);
});

// 🔴 THE REFUSAL. Every field is rendered with textContent, so a tag does not execute -- it
// ARRIVES ON SCREEN AS ANGLE BRACKETS. That is a defect a reader sees and a green suite does not,
// which is why it is caught at the one point every week has to pass through.
test("markup in a published field is REFUSED, and the field is named", () => {
  const ws = weekState();
  ws.days[0].sessions[0].oneRule = "Ease if the average is faster than <b>6:52/km</b>.";
  const r = publish(ws, "markup-session");

  assert.equal(r.code, 1, "a week carrying raw markup must not publish");
  assert.match(r.err, /carry raw markup/);
  assert.match(r.err, /days\[0\]\.sessions\[0\]\.oneRule/, "the operator must be told WHICH field");
});

test("markup anywhere in the payload is refused, not just in sessions", () => {
  const ws = weekState();
  ws.days[0].bed.text = "&rarr; 6h00, a floor rather than a gate.";
  const r = publish(ws, "markup-bed");

  assert.equal(r.code, 1, "an HTML entity is markup too");
  assert.match(r.err, /days\[0\]\.bed\.text/);
});

// THE GATE READS THE REDUCED PAYLOAD, NOT THE ARTIFACT -- which is the whole reason dropping a
// field from the allowlist is a real fix rather than a cosmetic one. `note` is the field this was
// found on: it carries <b> in the live week, and it is not published.
test("markup in a field that is NOT published cannot block the week", () => {
  const ws = weekState();
  ws.days[0].sessions[0].note = "Pace missed by <b>−14.7 s/km</b>.";
  const r = publish(ws, "markup-unpublished");

  assert.equal(r.code, 0, "a field the app never sees must not refuse the publish");
  assert.equal(r.err.includes("raw markup"), false);
});

// ⚠️ A WARNING AND NOT A REFUSAL, on purpose. This test reads English rather than syntax, and a
// gate that fires wrongly is a gate that gets switched off. It has to be loud and it has to let
// the week through.
test("a field that reads like a revision warns loudly, and still publishes", () => {
  const ws = weekState();
  ws.days[0].bed.text = "Corrected: my earlier version had this wrong.";
  const r = publish(ws, "revision");

  assert.equal(r.code, 0, "a revision marker must not block the week — the test is a guess at English");
  assert.match(r.out, /read like a revision/);
  assert.match(r.out, /days\[0\]\.bed\.text/);
  assert.match(r.out, /Not a refusal/);
});

test("an ordinary week trips neither gate", () => {
  const r = publish(weekState(), "quiet");
  assert.equal(r.code, 0);
  assert.equal(r.out.includes("read like a revision"), false, "the revision gate must not fire on ordinary prose");
  assert.equal(r.err.includes("raw markup"), false);
});

// 🔴 A REFUSAL HAS TO BE PRECISE, because it blocks the whole week and the operator's only recourse
// would be to weaken it. The first version of this gate matched "an angle bracket followed by a
// letter" case-insensitively, which made ANY bracketed word a tag: it refused a legitimate plan on
// `<TBA>`. These cases are the line between markup and ordinary training prose.
test("bracketed words that are not tags do not refuse the week", () => {
  const prose = [
    "<TBA>",                              // a venue not yet announced
    "<w/ Bryan>",                         // shorthand
    "HR <172 bpm, >150 on the last rep",  // two comparisons in one line
    "pace <5:30/km",
    "Kallang <-> home",
    "R&D; the club night",                // an ampersand that is not an entity
  ];
  for (let i = 0; i < prose.length; i++) {
    const ws = weekState();
    ws.days[0].sessions[0].place = prose[i];
    const r = publish(ws, `prose-${i}`);
    assert.equal(r.code, 0, `refused legitimate prose ${JSON.stringify(prose[i])}: ${r.err}`);
  }
});

test("every form of real markup is still caught", () => {
  const markup = ["<b>x</b>", "<em>x</em>", "<a href='y'>z</a>", "<br/>", "<SPAN>x</SPAN>", "&rarr;", "&nbsp;", "&#8594;"];
  for (let i = 0; i < markup.length; i++) {
    const ws = weekState();
    ws.days[0].sessions[0].place = "Kallang " + markup[i];
    const r = publish(ws, `markup-${i}`);
    assert.equal(r.code, 1, `let markup through: ${JSON.stringify(markup[i])}`);
  }
});
