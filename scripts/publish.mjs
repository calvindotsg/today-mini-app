#!/usr/bin/env node
// Publish a week to the edge.
//
//   node scripts/publish.mjs <week.html|week-state.json> [--put] [--no-notify]
//
// The input is the weekly training artifact's HTML, saved to disk. It CANNOT be fetched by a
// script: the artifact is a private Claude-account resource, so a cron on this Mac has no way to
// read it and the box has no route to claude.ai at all. A Claude Code session saves the file and
// runs this -- which is why the app treats "when was this published" as a first-class fact and
// says so on screen rather than assuming freshness.
//
// THE COMMENT TRAP. The artifact's own header comment names `id="week-state"` while explaining
// the format, so a regex for that id finds the DOCUMENTATION before the data and parses prose as
// JSON. Comments are stripped first. This has bitten this template before.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { reduceWeekState, ContractError } from "../src/reduce.js";
import { buildView } from "../src/view.js";
import { buildEnvelope } from "../src/notify.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KV_KEY = "week:current";
const WRANGLER = "wrangler@4.127.1"; // pinned. Bumping it is a decision: the runtime it bundles must support compatibility_date
const SIZE_BUDGET = 24 * 1024;       // fail-closed ceiling, see README "Payload size"

// ── THE NOTIFICATION ─────────────────────────────────────────────────────────────────────────
//
// A published week that nobody is told about is a week he finds by opening the app on the off
// chance. So a successful KV write also announces itself in Telegram, with the two Mini App
// buttons -- and it happens HERE rather than as a step in the skill, for the reason the two gates
// below already argue: a prose requirement lapses in silence and a command does not.
//
// 🔴 OVER SSH, NOT OVER HTTP, and that is the security design rather than a convenience. The
// Hermes box carries a Hetzner firewall with ZERO rules and its gateway container sits on an
// `internal: true` docker bridge with no published port; the tunnel's only two ingress rules are
// the dashboard and ssh. Reaching the webhook adapter from the internet would have meant a new
// public hostname -- and therefore a DNS record, which on calvin.sg must go through octoDNS in
// portfolio-v2 or break its weekly drift gate -- plus a new Access application, to serve exactly
// one caller that already has an Access-gated route in. `ssh-hermes` is that route. Nothing new
// is exposed, and no secret lives on this side: the box signs with a key this repo never sees.
// ── THE ARCHIVE ──────────────────────────────────────────────────────────────────────────────
//
// 🔴 dist/payload.json IS NOT A BACKUP, and on 2026-09-02 it was the only copy of a real week.
// A mutation-testing pass published a fixture over the live week in KV; the recovery came from
// dist/payload.json — and then the very next `npm test` OVERWROTE it, because the publisher
// rewrites that file on every run, --put or not. The artifact that saved the incident destroys
// itself. This writes a durable copy on a REAL publish only.
//
// ⚠️ OUTSIDE THE REPOSITORY, deliberately. `dist/` is gitignored scratch that `rm -rf dist`,
// a fresh clone and every test run are all entitled to erase. A recovery copy has to survive
// exactly those.
//
// ⚠️ AND OVERRIDABLE, because the tests spawn this publisher with a shimmed `npx` that "succeeds"
// — so without the override they would write fixtures into the real archive. Redirect-before-use,
// asserted in test/notify.test.mjs, is the same rule the Hermes TTS suite had to learn after
// writing 132 lines into the production log.
const ARCHIVE_DIR = process.env.TODAY_ARCHIVE_DIR
  || `${homedir()}/.local/state/today-mini-app/published`;

// ⚠️ AND `dist/` IS OVERRIDABLE FOR THE SAME REASON THE ARCHIVE IS. Two test files spawn this
// publisher and `node --test` runs files CONCURRENTLY, so both were writing `dist/payload.json`
// at once — and `dist/payload.json` is the artifact that recovered the live week on 2026-09-02.
// A suite racing over the operator's only recovery copy is the §16 shape exactly: bound the
// blast radius in the environment, then assert every spawn inherits it.
const DIST_DIR = process.env.TODAY_DIST_DIR || `${ROOT}/dist`;
// Printed, not the absolute path, so the default run's output stays the short line the
// routine quotes back — while an overridden run says out loud that it is not writing to dist/.
const DIST_LABEL = process.env.TODAY_DIST_DIR ? DIST_DIR : "dist";
const ARCHIVE_KEEP = 12;   // ~3 months of weekly publishes, plus mid-week reconciles

const SSH_HOST = "ssh-hermes";
const NOTIFY_CMD = "bin/hermes-week-notify";
const NOTIFY_TIMEOUT_MS = 60_000;

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const put = args.includes("--put");
const noNotify = args.includes("--no-notify");
// 🔴 WHO PASSES --strict, AND WHY IT IS NOT THE DEFAULT.
//
// `training-week-publish` runs this file at 23:40 every night and is PURE TRANSPORT: it cannot
// rewrite the artifact and it cannot ask. A length refusal there is an outage with no automated
// recovery -- and the precedent is on the record, the 6 Sep freshness stop left a week with no
// announce/ envelope for its whole first day. A stale phone is a worse failure than a wordy one.
//
// So length REFUSES only when a human is present to fix it, and always WARNS. The shape, markup,
// store-reference and acronym gates below refuse on both paths regardless: those are correctness,
// and this one is style.
const strict = args.includes("--strict");
if (!file) {
  console.error("usage: publish.mjs <week.html|week-state.json> [--put] [--no-notify] [--strict]");
  process.exit(2);
}

function extractWeekState(raw) {
  if (raw.trimStart().startsWith("{")) return JSON.parse(raw);
  const withoutComments = raw.replace(/<!--[\s\S]*?-->/g, "");
  const m = /<script[^>]*id="week-state"[^>]*>([\s\S]*?)<\/script>/.exec(withoutComments);
  if (!m) throw new ContractError("no #week-state block in that file");
  return JSON.parse(m[1]);
}

// Singapore time, written with its offset so the app's age arithmetic is unambiguous.
function sgtStamp(d = new Date()) {
  const t = new Date(d.getTime() + 8 * 3600_000).toISOString();
  return t.slice(0, 19) + "+08:00";
}

// ── TWO GATES ON THE CONTENT, because the shape being right is not the same as the words being
// publishable, and both rules below were prose in a document the app never reads until now.
//
// A prose requirement lapses silently; a command does not. That is the same argument the artifact
// schema already makes about being validated rather than merely described -- applied to the two
// things this app promises about what reaches the screen.

// 🔴 REFUSAL. Nothing raw crosses into this app. Every field is rendered with textContent, so a
// tag does not execute -- it ARRIVES ON SCREEN AS ANGLE BRACKETS, which is a defect a reader sees
// and a test suite does not. The artifact's own renderer treats several fields as raw HTML
// (CONTRACT.md names them), and `note` was one nobody had noticed until it was nearly published.
// Mechanical and precise, so it can be a refusal rather than a warning.
// ⚠️ NAMED TAGS AND NAMED ENTITIES, not "an angle bracket followed by a letter". The first version
// of this was /<\/?[a-z][^>]*>|&(?:[a-z]+|#\d+);/i and it REFUSED THE WHOLE WEEK on `<TBA>`,
// `<w/ Bryan>` and `R&D;` -- the /i flag makes [a-z] match any letter, so any bracketed word became
// a tag. A refusal has to be precise or it blocks a legitimate plan, and the operator's only
// recourse would be to weaken the gate. `\b` after each name is what keeps `<in the pack>` and
// `<Saturday>` out of it.
const TAGS = "a|abbr|b|br|code|div|em|i|mark|p|q|s|small|span|strong|sub|sup|u";
const ENTITIES = "amp|apos|bull|deg|gt|hellip|larr|lt|mdash|middot|minus|nbsp|ndash|quot|rarr|times";
const MARKUP = new RegExp(`<\\/?(?:${TAGS})\\b[^>]*>|&(?:${ENTITIES}|#\\d+);`, "i");

// ⚠️ WARNING, NOT REFUSAL. The app shows the plan's latest state and never the history of how it
// got there -- no "Corrected", no "Rewritten", no "two things I had wrong in the first version".
// But this test is a guess at English rather than a fact about syntax, and the weekly-page
// pipeline already learned the expensive version of this lesson: A GATE THAT FIRES WRONGLY GETS
// SWITCHED OFF. So it prints and does not block, and the entries are kept long enough to be
// specific.
const REVISION = /\b(?:corrected|rewritten|earlier version|first version|i had wrong|previously stated|was wrong|no longer true)\b/i;

// 🔴 REFUSAL. A REFERENCE INTO THE STORE THAT WROTE THE PLAN. Added 2026-09-03, after Calvin read
// his own phone and said the reason for Friday's run was "too technical which i don't understand".
// The field said, truthfully: "the discriminating observation models/pace-group asked for in
// writing on 2 Sep ... Pre-registered as F-2026-09-04-a."
//
// `models/pace-group` is a WIKI PAGE and `F-2026-09-04-a` is a FORECAST ID. He cannot open either,
// does not know they exist, and neither survives the trip to a phone. Unlike the vocabulary gate
// below, this is a fact about syntax rather than a guess at English: a slash-joined wiki path and a
// dated forecast id have exact shapes that do not occur in training prose. Precise enough to
// refuse, and the recourse is to say the fact instead of citing where it is filed.
const STORE_REF = /\b(?:models|athlete|goals|forecasts|programmes|raw|published)\/[a-z0-9][a-z0-9-]*|\bF-\d{4}-\d{2}-\d{2}[a-z]?\b/;

// 🔴 REFUSAL, AND IT IS SAFE TO REFUSE BECAUSE THERE IS ALWAYS A WAY OUT: spell the thing in full.
// Asked for by name on 2026-09-03 — "Avoid Acronyms as i might not know what it means, spell out in
// full instead — like MAS (Maximal aerobic speed)".
//
// ⚠️ Each entry carries its OWN escape hatch: the abbreviation is only refused when its expansion
// is absent from the SAME string. So "NRIC — your identity card" publishes and a bare "NRIC" does
// not, which is the behaviour asked for rather than a ban on capital letters.
//
// ⚠️ The keys are matched CASE-SENSITIVELY and on word boundaries, which is doing real work: `MAS`
// against "body mass" and `RE` against "recovery" are exactly the false positives that would make
// this gate fire wrongly, and a gate that fires wrongly gets switched off.
//
// 📌 Every expansion is a FACT taken from the wiki that owns it — programmes/arc.md is titled
// "ASICS Run Club", rd.md "Running Department", grc.md "Garmin Run Club Singapore", kcc.md "Kröl
// Cycling Club", lcrr.md "Lion City Road Runners", bft.md gives "Body Fit Training". An
// abbreviation whose expansion is NOT recorded in that store does not belong on this list: guessing
// one would publish a fabricated fact, which is worse than a short name he already knows.
// A studio class code (`Pump UB 275`, `XTX 187`) is a NAME, not an abbreviation — bft.md records
// that nothing has ever said what they stand for — so they are deliberately absent here.
const ACRONYMS = [
  ["MAS", /maximal aerobic speed/i],
  ["HRV", /heart[ -]rate variability/i],
  ["RE", /relative effort/i],
  ["PE", /perceived exertion/i],
  ["5RM", /5[ -]rep max|most you can lift 5 times/i],
  ["PB", /personal best/i],
  ["BTT", /basic theory test/i],
  ["ECP", /east coast park/i],
  ["NRIC", /identity card/i],
  ["BFT", /body fit training/i],
  ["ARC", /asics run club/i],
  ["RD", /running department/i],
  ["GRC", /garmin run club/i],
  ["KCC", /kr(?:ö|oe)l cycling club/i],
  ["LCRR", /lion city road runners/i],
];

// ⚠️ WARNING, NOT REFUSAL, and the split from the two refusals above is the whole design. These are
// ordinary English words this store happens to use in a private sense — "board" for a pace sign,
// "anchor" for an easy pace, "dial" for something adjustable. A word cannot be refused on the
// strength of a meaning it only sometimes has: "dial" is inside "dialled", "the sign" is a
// perfectly plain thing to write, and refusing either would block a correct plan. So this prints.
const VOCABULARY = /\b(?:easy anchor|the board|a board|pace board|discriminating|compression|constant bias|measured bias|two-regime|regime|confound|provenance|the dial|dials|MAE|n=\d)\b/i;

/** Every string in the payload, with the path it sits at, so a refusal can name the field. */
function* strings(node, path = "") {
  if (typeof node === "string") { yield [path, node]; return; }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) yield* strings(node[i], `${path}[${i}]`);
    return;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) yield* strings(v, path ? `${path}.${k}` : k);
  }
}

// 🔴 CLEARED BEFORE ANYTHING CAN REFUSE, and this is not tidiness.
//
// Every refusal below exits before `writeFileSync(dist/payload.json)`, so a refused run leaves
// LAST run's payload sitting there -- and the documented ship procedure's next step is
// `cp dist/payload.json published/<new stem>`. That copies a previous week under a fresh stem
// while the operator is reading a refusal. Removing them first turns that into a missing file,
// which fails loudly, instead of a wrong file, which does not fail at all.
for (const stale of ["payload.json", "envelope.json"]) {
  rmSync(`${DIST_DIR}/${stale}`, { force: true });
}

const rawInput = readFileSync(file, "utf8");

// 🔴 THE ONE-CHARACTER BYPASS, NAMED RATHER THAN LEFT TO BE DISCOVERED. `extractWeekState` accepts
// a bare JSON file, and the usage line advertises it. Every prose measurement below is therefore
// UNREACHABLE on that input -- silently, which is the shape of defect this file exists to refuse
// elsewhere. It is not an error (a JSON input is a legitimate way to re-check a reduced payload),
// but it must never look like a clean run of something that did not execute.
const inputIsArtifact = !rawInput.trimStart().startsWith("{");

let payload;
try {
  payload = reduceWeekState(extractWeekState(rawInput), { generatedAt: sgtStamp() });
} catch (e) {
  console.error(`REFUSED: ${e.message}`);
  console.error("The week-state contract is owned by the skill that writes the artifact, not by");
  console.error("this repository. If it has changed, fix src/reduce.js and CONTRACT.md --");
  console.error("do not loosen the check so a half-understood plan gets published.");
  process.exit(1);
}

const json = JSON.stringify(payload);
const bytes = Buffer.byteLength(json);

// Prove the thing being published actually renders into something, rather than merely parsing.
// A payload that reduces cleanly and then produces `ok:false` is a publish worth refusing.
const probe = buildView(JSON.parse(json), Date.now());
const sessions = payload.days.reduce((n, d) => n + d.sessions.length, 0);

// The kinds of night this week states, printed so a fourth artifact generation renaming "Gate" is
// visible HERE rather than never. `bed.kind` carries no enum on purpose -- it is printed verbatim
// by the app, so an unknown kind renders correctly and only drift is worth reporting.
const bedNights = payload.days.filter((d) => d.bed).length;
const bedKinds = [...new Set(payload.days.map((d) => d.bed?.kind).filter(Boolean))];

console.log(`week      ${payload.meta.weekLabel}  (${payload.meta.weekStart} .. ${payload.meta.weekEnd})`);
console.log(`content   ${payload.days.length} days, ${sessions} sessions`);
console.log(`bedtimes  ${bedNights}/${payload.days.length} nights stated — ${bedKinds.join(", ") || "(no kinds)"}`);
console.log(`size      ${bytes} bytes (ceiling ${SIZE_BUDGET})`);
console.log(`generated ${payload.generatedAt}`);
console.log(`today     ${probe.today} — covered by this plan: ${probe.coversToday ? "yes" : "NO"}`);
console.log(`now       ${probe.now ? probe.now.title : "(nothing ahead in the next three days)"}`);

// ── THE LENGTH COUNTERS ──────────────────────────────────────────────────────────────────────
//
// MEASUREMENT ONLY. Nothing below refuses, warns, or changes an exit code -- it prints numbers.
//
// 🔴 WHY MEASUREMENT SHIPS BEFORE ENFORCEMENT. The `training-week-publish` routine runs this file
// every night at 23:40 and is PURE TRANSPORT: it cannot rewrite the artifact and cannot ask. A
// refusal there is an outage with no automated recovery, and there is precedent -- the 6 Sep
// freshness stop left a week with no announce/ envelope for its whole first day. So the thresholds
// are derived from what these counters report over real weeks, and only then enforced.
//
// WHAT THIS IS FOR. The weekly artifact grew too wordy to read on a phone, and the cause was
// measured rather than guessed: across one week's six published payloads the session count held at
// 13 and no session gained a field, while the fields themselves grew -- the worst single session
// went 151 to 264 words and one `travel` went 136 to 428 characters, in a single day of reconciles.
// Nothing was appended. Each field was rewritten to include the derivation of its own change.
// These counters are what make that visible on the next publish instead of a month later.
const WATCHED = ["oneRule", "intention", "travel", "text"]; // `text` is bed.text -- the leaf key
const words = (s) => (s.trim() ? s.trim().split(/\s+/).length : 0);

const fieldMax = new Map();
for (const [path, s] of strings(payload)) {
  const leaf = path.split(".").pop().replace(/\[\d+\]$/, "");
  if (!WATCHED.includes(leaf)) continue;
  const key = leaf === "text" ? "bed.text" : leaf;
  const prev = fieldMax.get(key);
  if (!prev || s.length > prev.n) fieldMax.set(key, { n: s.length, path });
}

const sessionWords = [];
for (const day of payload.days) {
  for (const s of day.sessions) {
    let n = 0;
    for (const [, v] of strings(s)) n += words(v);
    sessionWords.push({ n, title: s.title, date: day.date });
  }
}
sessionWords.sort((a, b) => b.n - a.n);
let payloadWords = 0;
for (const [, s] of strings(payload.days)) payloadWords += words(s);

// ── THE THRESHOLDS ───────────────────────────────────────────────────────────────────────────
//
// CALIBRATED AGAINST THE TWELVE COMMITTED PAYLOADS IN published/, which are immutable, so this
// reproduces. The result that set every number: BOTH weeks' FIRST publish trips nothing, and every
// trip in the corpus was introduced by a mid-week reconcile. The gate cannot block a freshly
// planned week -- only one that has grown -- which is the empirical answer to "a gate that fires
// wrongly gets switched off" rather than an argument for it.
//
// ⚠️ TWO CALIBRATION RULES, BOTH LEARNED BY GETTING THEM WRONG FIRST.
//
// 1. NO THRESHOLD MAY FIRE ON THE SKILL'S OWN GOOD EXAMPLE. week-state.md holds a 224-character
//    `intention` up as the model answer -- the sentence written to replace one the athlete called
//    "too technical" -- so a 200 cap would have refused the documented right answer.
// 2. NO WARNING MAY FIRE ON A CLEAN FIRST PUBLISH. `travel` warned at 140 and `words per session`
//    at 120; measured, those fired on a 156-character travel that is entirely operational
//    ("briefing is 19:15 ... be there by 19:00") and on six of thirteen sessions in a normal week.
//    A warning on half the week every week is noise, and noise is how a gate gets switched off.
//    Raised to 200 and 160, which are above both weeks' first publish and below what a reconcile
//    grows them to.
const LIMITS = {
  oneRule:    { warn: 200, refuse: 320 },
  intention:  { warn: 240, refuse: 320 },
  travel:     { warn: 200, refuse: 240 },
  "bed.text": { warn: 160, refuse: 260 },
};
const SESSION_WORDS = { warn: 160, refuse: 200 };

// 🔴 TWO CANDIDATE CHECKS WERE MEASURED AND DROPPED. Recorded because the next session will think
// of both again.
//
// A clock-negation regex -- /\d{1,2}:\d{2}[^.]{0,40}\bnot\b[^.]{0,15}\d{1,2}:\d{2}/ -- was meant to
// catch "the time changed to 19:20 ... says 7.20pm". Run over the corpus it MISSED that string
// entirely (7.20pm carries no colon) and its only match anywhere was `6:06/km, not 6:00`, which is
// a correct pace instruction. Zero recall on its target, one false positive on a correct week.
//
// Strikethrough in prose is already covered where it counts: `s` and `del` are in MARKUP's tag
// list, so a struck published field is refused today. Rendered prose is not published, and a check
// that has never fired and cannot reach the screen is a subscription with no benefit.

const overLimit = [];
const overWords = [];

console.log("");
console.log(`lengths   ${strict ? "STRICT — over the refuse column is a refusal" : "warnings only — pass --strict to refuse"}`);
for (const key of ["oneRule", "intention", "travel", "bed.text"]) {
  const hit = fieldMax.get(key);
  const lim = LIMITS[key];
  const flag = !hit ? "" : hit.n > lim.refuse ? "  OVER" : hit.n > lim.warn ? "  over warn" : "";
  console.log(`          ${key.padEnd(10)} longest ${String(hit ? hit.n : 0).padStart(4)} chars  (warn ${lim.warn}, refuse ${lim.refuse})${hit ? `  ${hit.path}` : "  (absent)"}${flag}`);
}
// Reported on the LONGEST above, but collected across every field: a week with four 300-character
// travels has one number in the summary and four things to fix.
for (const [path, s] of strings(payload)) {
  const leaf = path.split(".").pop().replace(/\[\d+\]$/, "");
  const key = leaf === "text" ? "bed.text" : leaf;
  const lim = LIMITS[key];
  if (!lim || !WATCHED.includes(leaf)) continue;
  if (s.length > lim.warn) overLimit.push({ path, key, n: s.length, lim });
}
for (const s of sessionWords) if (s.n > SESSION_WORDS.warn) overWords.push(s);
const worst = sessionWords[0];
console.log(`          words per session  max ${worst ? worst.n : 0}${worst ? `  ${worst.date} ${worst.title.slice(0, 44)}` : ""}`);
console.log(`          words across all ${payload.days.length} days  ${payloadWords}`);

if (inputIsArtifact) {
  // Rendered prose, counted from the HTML rather than from class names. There is no stable class
  // vocabulary to count against -- two consecutive weeks of this artifact shared only 13 of ~48
  // classes -- so the section boundary is <h2>, which is structure rather than styling.
  const body = rawInput
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");
  // An apostrophe entity collapses a word in two if it becomes a space, so the few that sit
  // INSIDE a word are mapped to a character and everything else to a separator.
  const text = (h) => h
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:rsquo|lsquo|apos|#8217|#39);/gi, "'")
    .replace(/&[a-z]+;|&#\d+;/gi, " ");
  const totalWords = words(text(body));
  const sections = [];
  const parts = body.split(/<h2[^>]*>/i);
  for (const part of parts.slice(1)) {
    const heading = words(text(part.split(/<\/h2>/i)[0])) ? text(part.split(/<\/h2>/i)[0]).trim().replace(/\s+/g, " ") : "(untitled)";
    sections.push({ heading: heading.slice(0, 38), n: words(text(part)) });
  }
  sections.sort((a, b) => b.n - a.n);
  console.log(`          rendered words on the page  ${totalWords}`);
  for (const s of sections.slice(0, 4)) {
    console.log(`          section ${String(s.n).padStart(4)}  ${s.heading}`);
  }
} else {
  console.log("          prose counters SKIPPED — this input is JSON, not an artifact");
}

// ⚠️ SPENT SESSIONS SHIP FIELDS THE APP NEVER DRAWS, and this is a warning rather than a refusal
// for one measured reason: it fires on EVERY payload in the corpus including both first publishes,
// so refusing it would break tonight before the skill that writes it has been changed.
const SUPPRESSED = ["oneRule", "intention", "travel", "leaveBy", "numbers", "bring", "until"];
let spentFields = 0;
for (const day of payload.days) {
  for (const s of day.sessions) {
    if (s.status === "planned") continue;
    spentFields += SUPPRESSED.filter((k) => k in s).length;
  }
}
if (spentFields > 0) {
  console.log("");
  console.log(`warning   ${spentFields} field(s) on done/missed/skipped sessions are published and never drawn.`);
  console.log("          The app suppresses everything below the title on a spent session, so these are");
  console.log("          bytes on a mobile connection that nobody can read. Not a refusal.");
}

if (overLimit.length || overWords.length) {
  const bad = overLimit.filter((v) => v.n > v.lim.refuse);
  const badW = overWords.filter((v) => v.n > SESSION_WORDS.refuse);
  const out = strict && (bad.length || badW.length) ? console.error : console.log;
  const verb = strict && (bad.length || badW.length) ? "REFUSED:" : "warning  ";
  out("");
  out(`${verb} ${overLimit.length} field(s) and ${overWords.length} session(s) are longer than this week needs.`);
  for (const v of overLimit) {
    out(`  ${v.path}: ${v.n} chars (warn ${v.lim.warn}, refuse ${v.lim.refuse})`);
  }
  for (const v of overWords) {
    out(`  ${v.date} "${v.title.slice(0, 40)}": ${v.n} words (warn ${SESSION_WORDS.warn}, refuse ${SESSION_WORDS.refuse})`);
  }
  out("  A field states what is true now. The reason it changed belongs on the plan page,");
  out("  never inside the field -- see reconcile.md section 5 in the wiki.");
  if (strict && (bad.length || badW.length)) process.exit(1);
  if (!strict && (bad.length || badW.length)) {
    console.log("  Over the refuse column, but --strict was not passed, so this still publishes.");
  }
}

if (bytes > SIZE_BUDGET) {
  console.error(`REFUSED: ${bytes} bytes exceeds the ${SIZE_BUDGET} ceiling.`);
  process.exit(1);
}
if (!probe.ok) {
  console.error(`REFUSED: the reduced payload does not render — ${probe.error}`);
  process.exit(1);
}

const markup = [];
const revisions = [];
const storeRefs = [];
const acronyms = [];
const vocabulary = [];
for (const [path, s] of strings(payload)) {
  if (MARKUP.test(s)) markup.push([path, s]);
  if (REVISION.test(s)) revisions.push([path, s]);
  if (STORE_REF.test(s)) storeRefs.push([path, s]);
  if (VOCABULARY.test(s)) vocabulary.push([path, s]);
  for (const [abbr, expansion] of ACRONYMS) {
    // Case-sensitive, on a word boundary, and only when the string does not already say it in
    // full. `\b` around a key ending in a digit still behaves: "5RM" borders a space either side.
    if (new RegExp(`(?:^|[^A-Za-z0-9])${abbr}(?![A-Za-z0-9])`).test(s) && !expansion.test(s)) {
      acronyms.push([path, abbr, s]);
    }
  }
}

if (revisions.length > 0) {
  console.log("");
  console.log(`warning   ${revisions.length} field(s) read like a revision of an earlier plan.`);
  console.log("          The app shows the plan's latest state, not how it got there. Check that");
  console.log("          each of these is what the week IS rather than what it USED to be:");
  for (const [path, s] of revisions) console.log(`          ${path}: ${s.slice(0, 110)}`);
  console.log("          Not a refusal — this test reads English, and it can be wrong.");
}

if (vocabulary.length > 0) {
  console.log("");
  console.log(`warning   ${vocabulary.length} field(s) use this store's private vocabulary.`);
  console.log("          These are ordinary words with a meaning only the wiki knows. He reads them");
  console.log("          at 6am having read nothing else. Say the thing itself instead:");
  for (const [path, s] of vocabulary) console.log(`          ${path}: ${s.slice(0, 110)}`);
  console.log("          Not a refusal — this test reads English, and it can be wrong.");
}

if (storeRefs.length > 0) {
  console.error("");
  console.error(`REFUSED: ${storeRefs.length} published field(s) cite the store rather than the fact.`);
  console.error("A wiki page path or a forecast id is bookkeeping. He cannot open it, does not know");
  console.error("it exists, and it does not survive the trip to a phone. State the fact it holds --");
  console.error("do not delete the sentence, and do not loosen this gate.");
  for (const [path, s] of storeRefs) console.error(`  ${path}: ${s.slice(0, 110)}`);
  process.exit(1);
}

if (acronyms.length > 0) {
  console.error("");
  console.error(`REFUSED: ${acronyms.length} published field(s) use an abbreviation without spelling it out.`);
  console.error("Write it in full. The expansion is a FACT, so take it from the wiki page that owns");
  console.error("it -- never invent one. Saying it in full anywhere in the same field satisfies this.");
  for (const [path, abbr, s] of acronyms) console.error(`  ${path}: ${abbr} — ${s.slice(0, 100)}`);
  process.exit(1);
}

if (markup.length > 0) {
  console.error("");
  console.error(`REFUSED: ${markup.length} published field(s) carry raw markup.`);
  console.error("This app renders every field with textContent, so these would arrive on screen as");
  console.error("visible angle brackets. Drop the field from the allowlist in src/reduce.js, or ask");
  console.error("the artifact for plain text — do not strip the tags here, which only hides it.");
  for (const [path, s] of markup) console.error(`  ${path}: ${s.slice(0, 110)}`);
  process.exit(1);
}
if (!probe.coversToday) {
  // Not a refusal. Publishing next week's plan on Saturday is normal and correct; the app says
  // so on screen. But it is said out loud here so it is never a surprise.
  console.log("note      this plan does not cover today, and the app will say so plainly.");
}

mkdirSync(DIST_DIR, { recursive: true });
writeFileSync(`${DIST_DIR}/payload.json`, json);
console.log(`wrote     ${DIST_LABEL}/payload.json`);

// ── THE ENVELOPE, WRITTEN HERE AND NOT IN THE NOTIFY LEG ─────────────────────────────────────
//
// Built ONCE, before the `--put` gate, and reused verbatim by the notify leg below. Two reasons,
// and the second is the one that changed the architecture:
//
// 1. THE FILE AND THE MESSAGE MUST BE THE SAME BYTES. Building it twice would let the committed
//    record of what was announced differ from what was actually announced — by a clock tick
//    today, by a code path tomorrow. One build, one object, two consumers.
//
// 2. 🔴 THE UNATTENDED PATH NEVER REACHES THE NOTIFY LEG AT ALL. `training-week-publish` runs
//    with no flags: it reduces, commits the payload to the private wiki as
//    `published/<stem>.json`, and a GitHub Action writes the edge store on merge. `--put` is
//    never passed, so until now `buildEnvelope` was unreachable on the only path that publishes
//    unattended, and a week reached the phone with nothing announcing it.
//
//    The Hermes box cannot close that gap on its own side: it has NO node (measured 2026-09-02,
//    `node: command not found`), and src/notify.js says in its own header why re-implementing
//    this there would be wrong even if it did. So the routine copies this file to
//    `announce/<same stem>.json` in the wiki, and a timer on the box reads it VERBATIM and feeds
//    it to ~/bin/hermes-week-notify — the same tool, the same envelope, a different courier.
//
// ⚠️ It is `dist/`, which is gitignored scratch: this app never commits an envelope. The public
// repo must not hold session titles, places or leave-by times — that is the whole reason the
// payload lives in the private wiki. Writing it here is what lets a caller who has somewhere
// private to put it do so.
const envelope = buildEnvelope(payload, Date.now());
writeFileSync(`${DIST_DIR}/envelope.json`, JSON.stringify(envelope));
console.log(`wrote     ${DIST_LABEL}/envelope.json`);

if (!put) {
  console.log("\nnot published — re-run with --put to write it to the edge.");
  process.exit(0);
}

// KV is written through wrangler, NOT through the Worker. There is deliberately no authenticated
// write path on today.calvin.sg: a read-only public surface has no endpoint that changes state.
execFileSync("npx", ["--yes", WRANGLER, "kv", "key", "put", KV_KEY,
  "--path", `${DIST_DIR}/payload.json`, "--binding", "WEEK", "--remote",
  "--config", `${ROOT}/wrangler.jsonc`], { stdio: "inherit", cwd: ROOT });
console.log("published to the edge.");

// AFTER the write succeeded, never before: an archive of something that did not ship is a lie
// about what the edge is serving, and it is the copy someone will restore from.
let archived = null;
try {
  mkdirSync(ARCHIVE_DIR, { recursive: true });
  // Sortable by name, so the prune below needs no stat() and no clock.
  const stamp = payload.generatedAt.replace(/[:+]/g, "-");
  archived = `${ARCHIVE_DIR}/${payload.meta.weekStart}--${stamp}.json`;
  writeFileSync(archived, json);

  const kept = readdirSync(ARCHIVE_DIR).filter((f) => f.endsWith(".json")).sort();
  for (const stale of kept.slice(0, Math.max(0, kept.length - ARCHIVE_KEEP))) {
    rmSync(`${ARCHIVE_DIR}/${stale}`, { force: true });
  }
  console.log(`archived  ${archived}`);
} catch (e) {
  // ⚠️ A WARNING, NEVER A REFUSAL. The week is already at the edge; failing here would report a
  // successful publish as broken. But it is said out loud, because a silent archive failure is
  // indistinguishable from a working one right up until the day it is needed.
  console.error(`warning   could not write the archive copy: ${e.message}`);
  console.error("          The publish itself is fine. Recovery would fall back to KV.");
}

// ── and only now, tell him ───────────────────────────────────────────────────────────────────
//
// Everything above this line has already happened. The week IS at the edge, and the app WILL
// serve it, whatever happens next -- so a failure here must never read as a failed publish.
// That is why this is exit 3 and not exit 1, and why the line above stays printed. It is the
// same split ~/bin/hermes-maintenance on that box had to learn: a process whose one failure code
// means two different things forces the operator to guess which one they are looking at.
if (noNotify) {
  console.log("notify    skipped (--no-notify). Nothing has been sent to Telegram.");
  process.exit(0);
}

try {
  const out = execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20", SSH_HOST, NOTIFY_CMD], {
    input: JSON.stringify(envelope),
    encoding: "utf8",
    timeout: NOTIFY_TIMEOUT_MS,
    // stderr is inherited so the box's own refusal text reaches the operator verbatim rather
    // than being summarised by this script, which does not know what it means.
    stdio: ["pipe", "pipe", "inherit"],
  });
  for (const line of out.trimEnd().split("\n")) console.log(line);
  console.log(`notify    sent — next: ${envelope.next ? envelope.next.title : "(nothing ahead)"}`);
} catch (e) {
  console.error("");
  console.error(`NOT NOTIFIED: ${e.message.split("\n")[0]}`);
  console.error("The week IS published and the app is serving it. What failed is the message.");
  // 🔴 WHETHER RE-RUNNING IS SAFE DEPENDS ON WHICH HALF FAILED, and the two are not the same
  // mistake to make. The webhook wake is idempotent -- the box derives its delivery id from a
  // hash of the envelope, and the adapter drops a repeat inside an hour. `sendMessage` is NOT:
  // the Bot API has no such notion, so a re-run after a Telegram success posts a SECOND message.
  // hermes-week-notify splits its codes precisely so this advice can be right rather than
  // hedged: 3 means nothing was sent, 4 means the message went and only the wake did not.
  if (e.status === 4) {
    console.error("Its exit code says the Telegram message DID go out and only the agent wake");
    console.error("failed. Do NOT re-run this — that would post the message a second time.");
    console.error("The wake is what is missing, and it costs nothing to skip.");
  } else if (e.status === 3) {
    console.error("Its exit code says nothing was sent, so re-running is safe:");
    console.error(`  node scripts/publish.mjs ${file} --put`);
  } else {
    console.error("It did not get far enough to say which half failed. `ssh ssh-hermes true`");
    console.error("answers whether the box is reachable at all; check Telegram before re-running,");
    console.error("because a re-run would post a second message if the first one landed.");
  }
  process.exit(3);
}
