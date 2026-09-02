// The `?startapp=` deep link, tested against the SHIPPED SOURCE.
//
// `screenFor` and `launchParams` have to live inline in src/app.html -- the page is deliberately
// one document (see the CSP-nonce test in worker.http.test.mjs), so they cannot be imported. The
// alternative was a copy in a .js module, and view.test.mjs already records why that is worse: a
// mapping kept in one place and asserted in another "could go missing with every test still
// green". So these tests CUT THE REAL FUNCTIONS OUT OF THE FILE and run them. If either is
// renamed, deleted or reshaped, the extraction fails and the suite goes red -- which is the
// property a copy cannot have.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP = readFileSync(`${ROOT}/src/app.html`, "utf8");

/** Cut one `function <name>(...) { ... }` out of the page, brace-balanced. */
function extract(name) {
  const start = APP.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `src/app.html no longer defines ${name}()`);
  let depth = 0;
  let i = APP.indexOf("{", start);
  const open = i;
  for (; i < APP.length; i++) {
    if (APP[i] === "{") depth++;
    else if (APP[i] === "}" && --depth === 0) break;
  }
  assert.ok(i < APP.length, `${name}() has unbalanced braces`);
  return APP.slice(start, i + 1);
}

// A single evaluation carrying both functions and a `location` they can read, so `launchParams`
// runs exactly as it does in the client rather than against an injected argument it does not have.
function loadWith(hash, search) {
  const src = `${extract("launchParams")}\n${extract("screenFor")}\n` +
    `return { launchParams, screenFor };`;
  // eslint-disable-next-line no-new-func
  return new Function("location", "URLSearchParams", src)(
    { hash, search }, URLSearchParams,
  );
}

const DATA = "user=%7B%22id%22%3A1%7D&hash=abc";

// ── screenFor: the closed set ────────────────────────────────────────────────────────────────

test("screenFor maps `week` to the week screen and everything else to today", () => {
  const { screenFor } = loadWith("", "");
  assert.equal(screenFor("week"), "week");
  assert.equal(screenFor("today"), "today");
});

// 🔴 THE POINT OF THE FUNCTION. Telegram hands over whatever followed `?startapp=`, and every one
// of these is a real way to arrive: an old link, a typo, a stale bookmark, a probe. None of them
// may produce a third screen, and none may produce a blank one.
test("no other start parameter can select a screen", () => {
  const { screenFor } = loadWith("", "");
  for (const junk of [
    "", "Week", "WEEK", " week", "week ", "weekly", "wee", "days", "__proto__",
    "constructor", "toString", "0", "1", "true", "null", "undefined",
    "../week", "week&x=1", "<script>", "%77eek",
  ]) {
    assert.equal(screenFor(junk), "today", `${JSON.stringify(junk)} must fall back to today`);
  }
  // The three shapes an absent parameter actually arrives as.
  assert.equal(screenFor(undefined), "today");
  assert.equal(screenFor(null), "today");
  assert.equal(screenFor(false), "today");
});

// ── launchParams: where the parameter comes from ─────────────────────────────────────────────

test("the start parameter is read from the fragment, beside the credential", () => {
  const { launchParams } = loadWith(`#tgWebAppData=${DATA}&tgWebAppVersion=7.0&tgWebAppStartParam=week`, "");
  const p = launchParams();
  assert.equal(p.startParam, "week");
  assert.equal(p.version, "7.0", "reading the new field must not disturb the old one");
  assert.ok(p.data, "nor the credential");
});

test("the query string is read too, because some clients deliver a direct link there", () => {
  const { launchParams } = loadWith("", `?tgWebAppData=${DATA}&tgWebAppStartParam=week`);
  assert.equal(launchParams().startParam, "week");
});

// ⚠️ The loop returns on the FIRST source carrying tgWebAppData. A launch with no start parameter
// must come back as the empty string rather than undefined, or `screenFor` is reading a hole.
test("a launch with no start parameter yields an empty string, not undefined", () => {
  const { launchParams } = loadWith(`#tgWebAppData=${DATA}&tgWebAppVersion=7.0`, "");
  assert.equal(launchParams().startParam, "");
});

test("a launch with no credential at all still answers the full shape", () => {
  const { launchParams } = loadWith("", "");
  assert.deepEqual(launchParams(), { data: "", version: "", startParam: "" });
});

// 📌 NEGATIVE CONTROLS, RUN AND RECORDED 2026-09-02. This repo has no mutation driver, so each
// fix below was put back the way it was by hand and the whole suite re-run:
//
//   re-bind the start param to the credential's source   -> 3 red
//   ignore the signed v.startParam                       -> 2 red
//   drop the URL fallback in startParamOf                -> 2 red
//   stop the worker returning startParam                 -> 2 red
//   make validateInitData return "" for start_param      -> 2 red
//
// All five caught, subjects restored, 115/115 green afterwards.
//
// 🔴 THE CASE EVERY FIXTURE IN THIS FILE USED TO EXCLUDE, and the bug it hid.
//
// The old launchParams() returned on the FIRST source carrying `tgWebAppData` and read the start
// parameter out of THAT SAME SOURCE. Every fixture above puts both in one place, so the suite was
// green and structurally incapable of finding it: a corpus of well-formed launches describes a
// client that always behaves. On a real launch the week button opened `today`.
// ⚠️ `DATA` carries an `&`, so it cannot be the WHOLE value of a single parameter in a fixture
// that asserts what came back -- URLSearchParams splits it. The tests above only ever read
// `startParam`, which is why nobody noticed. These read `data`, so they use an opaque one.
const CRED = "cred-abc123";

test("the start parameter is found even when the credential is in the other source", () => {
  const { launchParams } = loadWith("#tgWebAppData=" + CRED, "?tgWebAppStartParam=week");
  const p = launchParams();
  assert.equal(p.data, CRED, "the credential still comes from the fragment");
  assert.equal(p.startParam, "week", "and the start parameter from wherever it actually is");
});

test("...and the other way round", () => {
  const { launchParams } = loadWith("#tgWebAppStartParam=week", "?tgWebAppData=" + CRED);
  const p = launchParams();
  assert.equal(p.data, CRED);
  assert.equal(p.startParam, "week");
});

// A start parameter with no credential is not a launch. It must not invent one.
test("a start parameter alone yields no credential", () => {
  const { launchParams } = loadWith("#tgWebAppStartParam=week", "");
  assert.deepEqual(launchParams(), { data: "", version: "", startParam: "week" });
});

// The version still travels with the credential -- it is a fact about the client that sent it,
// not about the link, so it must NOT be picked up from a source carrying no launch data.
test("the version is read from the source that carried the credential", () => {
  const { launchParams } = loadWith("#tgWebAppData=" + DATA + "&tgWebAppVersion=7.0",
                                    "?tgWebAppVersion=6.0");
  assert.equal(launchParams().version, "7.0");
});

// The fragment is checked before the query string. A link that somehow carried both must not let
// the query string decide -- the fragment is the one Telegram actually signs alongside.
test("the fragment wins when both carry launch parameters", () => {
  const { launchParams } = loadWith(
    `#tgWebAppData=${DATA}&tgWebAppStartParam=week`,
    `?tgWebAppData=${DATA}&tgWebAppStartParam=today`,
  );
  assert.equal(launchParams().startParam, "week");
});

// ── startParamOf: two sources, and the SIGNED one wins ───────────────────────────────────────
//
// Telegram duplicates `?startapp=` into the URL fragment AND into the verified initData. The page
// read only the first, which was a guess about where a client puts it. `start_param` is inside
// the data-check-string, so it is the copy the bot token vouches for -- and it costs nothing,
// because `screen` was never decided before the server answered anyway.
function loadStartParamOf(hash, search) {
  const src = `${extract("launchParams")}\nvar launch = launchParams();\n` +
    `${extract("startParamOf")}\nreturn startParamOf;`;
  // eslint-disable-next-line no-new-func
  return new Function("location", "URLSearchParams", src)({ hash, search }, URLSearchParams);
}

test("the verified start_param wins over the URL copy", () => {
  const f = loadStartParamOf("#tgWebAppData=cred&tgWebAppStartParam=today", "");
  assert.equal(f({ ok: true, startParam: "week" }), "week");
});

test("the URL copy is used when the server sent none", () => {
  const f = loadStartParamOf("#tgWebAppData=cred&tgWebAppStartParam=week", "");
  assert.equal(f({ ok: true, startParam: "" }), "week");
  assert.equal(f({ ok: true }), "week");
});

// 🔴 An error view carries no verified anything. Falling back to the URL copy there is what keeps
// the refusal on one screen -- and screenFor is still the closed set, so neither source can name
// a third.
test("a refusal never takes a start parameter from the view", () => {
  const f = loadStartParamOf("", "");
  assert.equal(f({ ok: false, startParam: "week" }), "");
});

// ── the wiring, asserted on the page itself ──────────────────────────────────────────────────
//
// The two tests above prove the functions are right. This one proves they are CONNECTED -- both
// could be perfect and never called, and every assertion above would still pass.
test("render boots the screen from the deep link, and only when there is a week", () => {
  assert.match(APP, /screen = v && v\.ok \? screenFor\(startParamOf\(v\)\) : "today"/,
    "render() must choose the screen from the start parameter, and fall back on an error view");
  // TWO SOURCES, and the SIGNED one wins. The page read only the URL copy until a real launch
  // opened on `today` with `?startapp=week` tapped.
  assert.match(APP, /if \(v && v\.ok && v\.startParam\) return v\.startParam;/,
    "the verified start_param from initData must be preferred over the URL copy");
  assert.match(APP, /return \(launch && launch\.startParam\) \|\| "";/,
    "and the URL copy must still be the fallback");
  assert.match(APP, /setBackButton\(screen === "week"\)/,
    "a launch that opens on the week must light the back arrow, or the reader is stranded there");
  assert.match(APP, /root\.setAttribute\("aria-label", screen === "week" \? "The week" : "Today"\)/,
    "the landmark must name the screen actually painted");
});
