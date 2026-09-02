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

// The fragment is checked before the query string. A link that somehow carried both must not let
// the query string decide -- the fragment is the one Telegram actually signs alongside.
test("the fragment wins when both carry launch parameters", () => {
  const { launchParams } = loadWith(
    `#tgWebAppData=${DATA}&tgWebAppStartParam=week`,
    `?tgWebAppData=${DATA}&tgWebAppStartParam=today`,
  );
  assert.equal(launchParams().startParam, "week");
});

// ── the wiring, asserted on the page itself ──────────────────────────────────────────────────
//
// The two tests above prove the functions are right. This one proves they are CONNECTED -- both
// could be perfect and never called, and every assertion above would still pass.
test("render boots the screen from the deep link, and only when there is a week", () => {
  assert.match(APP, /screen = v && v\.ok \? screenFor\(launch && launch\.startParam\) : "today"/,
    "render() must choose the screen from the start parameter, and fall back on an error view");
  assert.match(APP, /setBackButton\(screen === "week"\)/,
    "a launch that opens on the week must light the back arrow, or the reader is stranded there");
  assert.match(APP, /root\.setAttribute\("aria-label", screen === "week" \? "The week" : "Today"\)/,
    "the landmark must name the screen actually painted");
});
