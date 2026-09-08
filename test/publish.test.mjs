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
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
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
// 🔴 AND `dist/` TOO, for a reason the archive redirect does not cover. `node --test` runs test
// FILES concurrently, so this suite and test/notify.test.mjs were both writing the operator's
// real dist/payload.json at the same time — the artifact that recovered the live week on
// 2026-09-02. Two suites racing over the only recovery copy is the same defect as writing to the
// production log, one directory along.
process.env.TODAY_DIST_DIR = join(TMP, "dist");

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

// ── plain English, added 2026-09-03 ─────────────────────────────────────────────────────────
//
// Calvin read Friday's reason on his own phone and said it was "too technical which i don't
// understand". The field cited a wiki page and a forecast id -- truthfully, and uselessly, because
// he cannot open either. These gates are that complaint turned into a command.
//
// 🔴 THE SPLIT IS THE DESIGN, and it is the same split the two older gates already draw: a wiki
// path and a dated forecast id have EXACT SHAPES, so they can be refused; "board" and "anchor" are
// ordinary English words with a private meaning, so they only warn. A gate that fires wrongly gets
// switched off, and this file already carries the `<TBA>` scar to prove it.

test("a wiki page path is refused, and the field is named", () => {
  const ws = weekState();
  ws.days[0].sessions[0].intention = "The observation models/pace-group asked for on 2 Sep.";
  const r = publish(ws, "store-ref-wiki");

  assert.equal(r.code, 1, "a path into the store that wrote the plan must not reach the phone");
  assert.match(r.err, /cite the store rather than the fact/);
  assert.match(r.err, /days\[0\]\.sessions\[0\]\.intention/, "and it must say WHICH field");
});

test("a forecast id is refused too", () => {
  const ws = weekState();
  ws.days[0].sessions[0].intention = "Pre-registered as F-2026-09-04-a before the run.";
  const r = publish(ws, "store-ref-forecast");
  assert.equal(r.code, 1, "a forecast id is bookkeeping, not a reason to run");
  assert.match(r.err, /cite the store/);
});

// 🔴 THE ESCAPE HATCH IS WHAT MAKES THE REFUSAL SAFE. A refusal with no way out gets weakened; this
// one is satisfied by doing the thing that was asked for -- saying the words.
test("an abbreviation is refused bare and accepted once it is spelled out", () => {
  const bare = weekState();
  bare.days[0].sessions[0].intention = "The MAS test at 110%, recorded in full.";
  const a = publish(bare, "acronym-bare");
  assert.equal(a.code, 1, "a bare abbreviation must not publish");
  assert.match(a.err, /without spelling it out/);
  assert.match(a.err, /MAS/);

  const spelled = weekState();
  spelled.days[0].sessions[0].intention =
    "The Maximal Aerobic Speed test (MAS) at 110%, recorded in full.";
  const b = publish(spelled, "acronym-spelled");
  assert.equal(b.code, 0, "naming it in full in the same field is the way through: " + b.err);
});

// 🔴 THE FALSE-POSITIVE CONTROL, and the reason the keys are matched case-sensitively on word
// boundaries. `MAS` inside "body mass" and `RE` inside "recovery" are real strings from real weeks
// -- the scan I ran by hand on 2026-09-03 flagged "Evolt body mass" and I had to discard it as
// noise. A gate that does that on every publish is one the operator learns to ignore.
test("ordinary words that merely contain an abbreviation do not refuse the week", () => {
  const prose = [
    "54.0 kg body mass, 48.5 kg lean mass",   // MAS
    "recovery cut from 20 s to 15 s",         // RE
    "the pack rides away",                    // PB, ARC
    "Kallang, then the park connector",       // PE, ECP
    "read the board and hold it",             // BTT/RD as substrings
    "arc of the bend at 4 km",                // ARC lowercase
  ];
  for (let i = 0; i < prose.length; i++) {
    const ws = weekState();
    ws.days[0].sessions[0].place = prose[i];
    const r = publish(ws, `acronym-fp-${i}`);
    assert.equal(r.code, 0, `refused ordinary prose ${JSON.stringify(prose[i])}: ${r.err}`);
  }
});

// ⚠️ A WARNING, NEVER A REFUSAL. "the board" is a pace sign here and a plank of wood everywhere
// else; the gate says so and gets out of the way.
test("the store's private vocabulary warns loudly, and still publishes", () => {
  const ws = weekState();
  ws.days[0].sessions[0].intention = "The first board faster than your easy anchor.";
  const r = publish(ws, "vocabulary");

  assert.equal(r.code, 0, "an English guess must not block the week");
  assert.match(r.out, /private vocabulary/);
  assert.match(r.out, /Not a refusal/);
});

test("a plainly-written week trips none of the three new gates", () => {
  const ws = weekState();
  ws.days[0].sessions[0].intention =
    "Your only run at race pace before Kiprun. Say the pace out loud to Bryan before you start.";
  const r = publish(ws, "plain");

  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.includes("private vocabulary"), false);
  assert.equal(r.err.includes("cite the store"), false);
  assert.equal(r.err.includes("spelling it out"), false);
});

// ── THE LENGTH COUNTERS ──────────────────────────────────────────────────────────────────────
//
// MEASUREMENT, NOT A GATE. These ship before any threshold does, because the routine that runs
// this publisher every night at 23:40 is pure transport and cannot fix what a refusal objects to.
// The thresholds come later, derived from what these report over real weeks.
//
// 🔴 AND THIS IS THE FIRST TEST IN THE SUITE THAT FEEDS THE PUBLISHER HTML. Every gate before it
// was exercised on a bare JSON week-state -- which `extractWeekState` accepts, and which skips
// everything that reads the page. A counter nobody runs on an artifact is a counter that reports
// whatever it likes about one.

/** The smallest artifact that is still an artifact: two <h2> sections around a real week-state. */
function artifact(ws, prose = "") {
  return `<!doctype html><html><head><title>W</title></head><body>
<h2>The week</h2><p>Monday. ${prose}</p>
<h2>The arithmetic</h2><p>Forty four point two three kilometres against a ceiling.</p>
<script type="application/json" id="week-state">${JSON.stringify(ws)}</script>
</body></html>`;
}

function publishHtml(ws, name, prose = "") {
  const file = join(TMP, `${name}.html`);
  writeFileSync(file, artifact(ws, prose));
  const r = spawnSync(process.execPath, [PUBLISH, file], {
    encoding: "utf8", cwd: ROOT, env: sandboxEnv(join(TMP, "bin")),
  });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

test("the counters name the longest field AND the path it sits at", () => {
  const ws = weekState();
  ws.days[0].sessions[0].travel = "x".repeat(300);
  const r = publish(ws, "counter-longest");

  assert.equal(r.code, 0, r.err);
  // The path is the half that matters: "travel is 300 chars" sends you looking through seven days.
  assert.match(r.out, /travel\s+longest\s+300 chars.*days\[0\]\.sessions\[0\]\.travel/);
});

test("a field that is absent reports as absent rather than as zero-length", () => {
  // An unwritten field and an empty one are different facts, and `pick` collapses empty to absent
  // upstream. Printing "0 chars" for both would report a week as tighter than it is.
  const r = publish(weekState(), "counter-absent");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /travel\s+longest\s+0 chars.*\(absent\)/);
});

test("words per session is counted across every field, and points at the worst one", () => {
  // ⚠️ THIS ASSERTION USED TO EXPECT THE SESSION'S TITLE, and that turned out to be the defect
  // rather than the feature -- the nightly routine reports this stdout into a push notification and
  // redacts only the `now` line. What the test protects is unchanged: the counter must say WHICH
  // session, not merely emit a number. It says so by address on the default path now.
  const ws = weekState();
  ws.days[0].sessions[0].intention = "one two three four five six seven eight nine ten";
  ws.days[0].sessions[0].travel = "eleven twelve thirteen fourteen fifteen";
  const r = publish(ws, "counter-session");

  assert.equal(r.code, 0, r.err);
  // Field-agnostic on purpose: every per-field cap can be evaded by moving a sentence next door.
  assert.match(r.out, /words per session\s+max \d+\s+2026-08-31 days\[0\]\.sessions\[0\]/);
});

test("an artifact gets its rendered prose counted, by <h2> and not by class name", () => {
  // Counted from structure rather than styling: two consecutive weeks of the real artifact shared
  // only 13 of ~48 CSS classes, so a class-based counter silently reports zero on a redraw.
  const r = publishHtml(weekState(), "counter-html", "alpha beta gamma delta epsilon");

  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /rendered words on the page\s+\d+/);
  assert.match(r.out, /section\s+\d+\s+The week/);
});

test("a JSON input SAYS the prose counters did not run, rather than passing quietly", () => {
  // `extractWeekState` accepts a bare JSON file and the usage line advertises it, so every prose
  // measurement is unreachable on that input. Silence there reads exactly like a clean page.
  const r = publish(weekState(), "counter-json-bypass");

  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /prose counters SKIPPED — this input is JSON, not an artifact/);
  assert.equal(r.out.includes("rendered words on the page"), false);
});

test("nothing measured can change the exit code on the DEFAULT path", () => {
  // 🔴 THIS TEST OUTLIVED THE WORDING IT USED TO ASSERT, AND THAT IS THE POINT. It shipped with
  // the counters, when the banner read "measurement only". Thresholds arrived a PR later and the
  // banner changed -- but what this protects did not: a week that trips every threshold still
  // publishes on the path the 23:40 transport routine takes. Asserting the behaviour rather than
  // the banner is what keeps it true through the next rewording.
  const ws = weekState();
  ws.days[0].sessions[0].travel = "y".repeat(2000);
  ws.days[0].sessions[0].intention = "z ".repeat(500);
  const r = publish(ws, "counter-no-gate");

  assert.equal(r.code, 0, "the default path must never refuse on length");
  assert.match(r.out, /pass --strict to refuse/);
  assert.match(r.out, /longer than this week needs/, "and it must still SAY so");
});

// ── THE LENGTH THRESHOLDS ────────────────────────────────────────────────────────────────────
//
// Calibrated against the twelve committed payloads in the wiki's published/, which are immutable.
// The property that set every number is the first test below: a freshly planned week passes, and
// only a week that has GROWN trips anything.

function publishStrict(ws, name) {
  const file = join(TMP, `${name}.json`);
  writeFileSync(file, JSON.stringify(ws));
  const r = spawnSync(process.execPath, [PUBLISH, file, "--strict"], {
    encoding: "utf8", cwd: ROOT, env: sandboxEnv(join(TMP, "bin")),
  });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

test("length REFUSES under --strict and merely warns without it", () => {
  // 🔴 THE WHOLE DESIGN IN ONE TEST. training-week-publish runs this at 23:40 as pure transport:
  // it cannot rewrite the artifact and cannot ask, so a length refusal there is an outage with no
  // recovery. A stale phone is a worse failure than a wordy one, so length refuses only when a
  // human is present. Correctness gates (markup, store refs, acronyms) refuse on both paths.
  const ws = weekState();
  ws.days[0].sessions[0].travel = "x".repeat(400);

  const loose = publish(ws, "gate-loose");
  assert.equal(loose.code, 0, "the nightly transport path must still ship");
  assert.match(loose.out, /Over the refuse column, but --strict was not passed/);

  const tight = publishStrict(ws, "gate-strict");
  assert.equal(tight.code, 1, "a human running it must be stopped");
  assert.match(tight.err, /days\[0\]\.sessions\[0\]\.travel: 400 chars/);
});

test("a refusal leaves NO dist/payload.json to be shipped by mistake", () => {
  // Every refusal exits before dist/ is written, so a refused run used to leave LAST run's payload
  // there -- and the ship procedure's next step is `cp dist/payload.json published/<new stem>`.
  // That copies a previous week under a fresh stem while the operator reads a refusal.
  const good = publish(weekState(), "dist-seed");
  assert.equal(good.code, 0, good.err);
  const dist = join(process.env.TODAY_DIST_DIR, "payload.json");
  assert.equal(existsSync(dist), true, "the good run must have written one");

  const ws = weekState();
  ws.days[0].sessions[0].oneRule = "y".repeat(400);
  assert.equal(publishStrict(ws, "dist-refuse").code, 1);
  assert.equal(existsSync(dist), false, "a refusal must leave nothing behind to copy");
});

test("the skill's own good intention passes clean, warn included", () => {
  // 🔴 CALIBRATION GUARD. week-state.md holds this 224-character sentence up as the model answer --
  // it is the one written to replace an intention the athlete called "too technical which i don't
  // understand". A cap that fires on the documented right answer teaches the next session to
  // distrust the cap, so this is pinned rather than left to whoever next edits LIMITS.
  const ws = weekState();
  ws.days[0].sessions[0].intention =
    "This is the first time you have been asked to run faster than your normal easy pace, and the " +
    "first time you are the one setting the pace for other people rather than following someone. " +
    "Worth paying attention to how it feels.";
  assert.equal(ws.days[0].sessions[0].intention.length, 224);

  const r = publishStrict(ws, "gate-exemplar");
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.includes("longer than this week needs"), false);
});

test("splitting one long field into two still trips the session cap", () => {
  // Every per-field cap can be evaded by moving a sentence next door. The words-per-session cap is
  // the only field-agnostic instrument here, and it is the one that measures what actually grew.
  const ws = weekState();
  const filler = "word ".repeat(60);
  ws.days[0].sessions[0].travel = filler;      // 60 words, under the travel char cap on its own
  ws.days[0].sessions[0].intention = filler;   // another 60
  ws.days[0].sessions[0].oneRule = filler;     // and another

  const r = publishStrict(ws, "gate-split");
  assert.equal(r.code, 1, "the session total must catch what the field caps let through");
  assert.match(r.err, /\d+ words \(warn 160, refuse 200\)/);
});

test("fields on a spent session warn and never refuse", () => {
  // Measured before choosing the severity: this fires on EVERY payload in the corpus, both first
  // publishes included. Refusing it would break tonight, before the skill that emits it changed.
  const ws = weekState();
  ws.days[0].sessions[0].status = "done";
  const r = publishStrict(ws, "gate-spent");

  assert.equal(r.code, 0, "a spent session must never block a publish");
  assert.match(r.out, /field\(s\) on done\/missed\/skipped sessions are published and never drawn/);
});

test("the default path names no session, because a cron reports its whole stdout", () => {
  // 🔴 A PRIVACY RULE THAT LIVES IN ANOTHER SYSTEM'S PROMPT, PINNED HERE WHERE IT CAN FAIL.
  // `training-week-publish` is instructed to report this script's FULL stdout, and its own prompt
  // says: "Never print the artifact body, any session name, any place ... your final report is
  // summarised into a push notification on the athlete's phone." It redacts exactly ONE line -- the
  // `now` line -- because that was the only line naming a session when the prompt was written.
  //
  // So any new line here that prints a title puts a name where the routine has no rule for it, and
  // the routine cannot redact a line nobody told it about. The counters shipped with that defect
  // and this is what stops it coming back.
  const ws = weekState();
  ws.days[0].sessions[0].travel = "x".repeat(300);
  ws.days[0].sessions[0].title = "Sensitive Place Run with Someone";

  const cron = publish(ws, "no-names-cron");
  assert.equal(cron.code, 0, cron.err);
  assert.equal(cron.out.includes("Sensitive Place Run"), false,
    "the default path must not print a session title anywhere");
  assert.match(cron.out, /words per session\s+max \d+\s+\S+ days\[0\]\.sessions\[0\]/,
    "it must still say WHICH session, by address");

  // A person gets the name, because a person has to find the thing.
  const person = publishStrict(ws, "no-names-person");
  assert.match(person.err + person.out, /Sensitive Place Run/);
});
