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
const ARCHIVE_KEEP = 12;   // ~3 months of weekly publishes, plus mid-week reconciles

const SSH_HOST = "ssh-hermes";
const NOTIFY_CMD = "bin/hermes-week-notify";
const NOTIFY_TIMEOUT_MS = 60_000;

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const put = args.includes("--put");
const noNotify = args.includes("--no-notify");
if (!file) {
  console.error("usage: publish.mjs <week.html|week-state.json> [--put] [--no-notify]");
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

const envelope = buildEnvelope(payload, Date.now());
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
