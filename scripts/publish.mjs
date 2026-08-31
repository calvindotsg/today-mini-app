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

console.log(`week      ${payload.meta.weekLabel}  (${payload.meta.weekStart} .. ${payload.meta.weekEnd})`);
console.log(`content   ${payload.days.length} days, ${sessions} sessions`);
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
