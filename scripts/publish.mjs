#!/usr/bin/env node
// Publish a week to the edge.
//
//   node scripts/publish.mjs <week.html|week-state.json> [--put] [--dry-run]
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

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { reduceWeekState, ContractError } from "../src/reduce.js";
import { buildView } from "../src/view.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KV_KEY = "week:current";
const WRANGLER = "wrangler@4.127.1"; // pinned. Bumping it is a decision: the runtime it bundles must support compatibility_date
const SIZE_BUDGET = 24 * 1024;       // fail-closed ceiling, see README "Payload size"

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const put = args.includes("--put");
if (!file) {
  console.error("usage: publish.mjs <week.html|week-state.json> [--put]");
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

let payload;
try {
  payload = reduceWeekState(extractWeekState(readFileSync(file, "utf8")), { generatedAt: sgtStamp() });
} catch (e) {
  console.error(`REFUSED: ${e.message}`);
  console.error("The week-state contract is owned by the Claude project that writes the artifact,");
  console.error("not by this repository. If it has changed, fix src/reduce.js and CONTRACT.md --");
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
for (const [path, s] of strings(payload)) {
  if (MARKUP.test(s)) markup.push([path, s]);
  if (REVISION.test(s)) revisions.push([path, s]);
}

if (revisions.length > 0) {
  console.log("");
  console.log(`warning   ${revisions.length} field(s) read like a revision of an earlier plan.`);
  console.log("          The app shows the plan's latest state, not how it got there. Check that");
  console.log("          each of these is what the week IS rather than what it USED to be:");
  for (const [path, s] of revisions) console.log(`          ${path}: ${s.slice(0, 110)}`);
  console.log("          Not a refusal — this test reads English, and it can be wrong.");
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

mkdirSync(`${ROOT}/dist`, { recursive: true });
writeFileSync(`${ROOT}/dist/payload.json`, json);
console.log(`wrote     dist/payload.json`);

if (!put) {
  console.log("\nnot published — re-run with --put to write it to the edge.");
  process.exit(0);
}

// KV is written through wrangler, NOT through the Worker. There is deliberately no authenticated
// write path on today.calvin.sg: a read-only public surface has no endpoint that changes state.
execFileSync("npx", ["--yes", WRANGLER, "kv", "key", "put", KV_KEY,
  "--path", `${ROOT}/dist/payload.json`, "--binding", "WEEK", "--remote",
  "--config", `${ROOT}/wrangler.jsonc`], { stdio: "inherit", cwd: ROOT });
console.log("published to the edge.");
