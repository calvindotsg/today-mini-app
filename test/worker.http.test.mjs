// The auth suite that actually matters: the four cases from the plan, run against the REAL
// Worker in the REAL runtime (workerd, via `wrangler dev --local`), over HTTP.
//
// A unit test of validateInitData proves the algorithm. It does NOT prove that the Worker wires
// the user-id check in, that a rejection carries an EMPTY BODY, or that a 401 does not ship the
// page anyway -- which is a real bug and an easy one to write. Every assertion below reads the
// response body and asserts its length, not just the status code.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mintInitData, FAKE_BOT_TOKEN, ALLOWED_ID } from "./helpers.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;

let dev;

before(async () => {
  dev = spawn("npx", ["--yes", "wrangler@4.127.1", "dev", "--local", "--port", String(PORT), "--inspector-port", "0"],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  dev.stdout.on("data", () => {});
  dev.stderr.on("data", () => {});
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      const r = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(2000) });
      if (r.status === 200) { await r.text(); break; }
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error("wrangler dev did not come up within 90 s");
    await new Promise((r) => setTimeout(r, 500));
  }
  // Seed the emulated KV so the happy path has something to render. Written through the same
  // Worker binding the deployed one reads.
  const seed = {
    v: 1,
    generatedAt: new Date().toISOString().slice(0, 19) + "+08:00",
    meta: { weekLabel: "Test week", weekStart: "2000-01-01", weekEnd: "2099-12-31" },
    days: [{ date: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10), dow: "Today",
             sessions: [{ kind: "Run · test", title: "ZZTITLEZZ", status: "planned",
                          place: "ZZPLACEZZ", leaveBy: "2099-01-01T05:55", oneRule: "ZZRULEZZ" }] }],
  };
  const { writeFileSync, mkdirSync } = await import("node:fs");
  mkdirSync(`${ROOT}/dist`, { recursive: true });
  writeFileSync(`${ROOT}/dist/kv-seed.json`, JSON.stringify(seed));
  const { execFileSync } = await import("node:child_process");
  execFileSync("npx", ["--yes", "wrangler@4.127.1", "kv", "key", "put", "week:current",
    "--path", `${ROOT}/dist/kv-seed.json`, "--binding", "WEEK", "--local"],
    { cwd: ROOT, stdio: "ignore" });
});

after(() => { dev?.kill("SIGTERM"); });

const post = (initData) => fetch(`${BASE}/s`, {
  method: "POST", body: initData,
  headers: { "Content-Type": "text/plain;charset=UTF-8" }, redirect: "manual",
});

async function assertDenied(res, what) {
  const body = await res.text();
  assert.equal(res.status, 401, `${what}: expected 401`);
  assert.equal(body.length, 0, `${what}: expected an EMPTY body, got ${body.length} bytes`);
  assert.equal(res.headers.get("content-type"), null, `${what}: a denial must not declare a content type`);
}

// ── the plan's four cases ──────────────────────────────────────────────────────────────────

test("valid initData for Calvin -> 200 and the week, as JSON", async () => {
  const res = await post(mintInitData({ userId: ALLOWED_ID }));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  const view = await res.json();
  assert.equal(view.ok, true);
  assert.equal(view.now.title, "ZZTITLEZZ", "the week must cross the boundary only here");
  assert.equal(view.now.place, "ZZPLACEZZ");
});

test("valid signature, DIFFERENT user.id -> 401, no content", async () => {
  // The case most likely to be skipped, and the only one that proves this is an access control
  // rather than a signature check. This initData is genuinely, correctly signed by the bot.
  await assertDenied(await post(mintInitData({ userId: 999999999 })), "stranger");
});

test("tampered hash -> 401, no content", async () => {
  await assertDenied(await post(mintInitData({ corruptHash: true })), "tampered");
});

test("auth_date two hours old -> 401, no content", async () => {
  const authDate = Math.floor(Date.now() / 1000) - 7200;
  await assertDenied(await post(mintInitData({ authDate })), "replayed");
});

// ── everything else the surface exposes ────────────────────────────────────────────────────

test("no initData at all -> 401, no content", async () => {
  await assertDenied(await post(""), "empty");
});

test("initData signed with the wrong bot token -> 401, no content", async () => {
  await assertDenied(await post(mintInitData({ botToken: "999:not-the-bot" })), "wrong-bot");
});

// THE PROPERTY THAT ACTUALLY MATTERS. The page is served to anyone -- it has to be, because
// Telegram puts the launch in a URL fragment no server ever sees -- so what must be true is that
// it carries NONE OF THE WEEK. Asserted against distinctive values seeded into KV, so a pass is a
// measurement rather than a guess at what the plan's words look like.
test("GET / carries the renderer but none of the week's content", async () => {
  const res = await fetch(`${BASE}/`);
  const body = await res.text();
  assert.equal(res.status, 200);
  for (const secret of ["ZZTITLEZZ", "ZZPLACEZZ", "ZZRULEZZ", "2099-01-01T05:55"]) {
    assert.doesNotMatch(body, new RegExp(secret), `the unauthenticated page leaked ${secret}`);
  }
  assert.doesNotMatch(body, /week:current/, "nor the name of where the week lives");
  assert.match(body, /<title>Today<\/title>/, "but it IS the app, not a stub");
  assert.match(res.headers.get("content-security-policy") ?? "", /script-src 'nonce-/);
  assert.doesNotMatch(res.headers.get("content-security-policy") ?? "", /unsafe-inline/);
});

// The regression control for the bug that made the page render blank: the page and the data it
// fetches must be ONE document, so there is exactly one nonce in play.
test("the page's CSP nonce matches the one stamped on its own inline script and style", async () => {
  const res = await fetch(`${BASE}/`);
  const body = await res.text();
  const headerNonce = (res.headers.get("content-security-policy") ?? "").match(/nonce-([A-Za-z0-9]+)/)?.[1];
  const bodyNonces = [...new Set([...body.matchAll(/nonce="([A-Za-z0-9]+)"/g)].map((m) => m[1]))];
  assert.ok(headerNonce, "the response must carry a nonce");
  assert.deepEqual(bodyNonces, [headerNonce], "every inline block must carry the header's nonce, and only it");
  // The CALL form, not the words. A bare /document\.write/ matches the comment in app.html that
  // explains why this must never come back -- an assertion that greps a whole file will happily
  // fire on its own documentation.
  assert.doesNotMatch(body, /document\.write\s*\(/, "a second document would get a second nonce and render blank");
  assert.doesNotMatch(body, /document\.open\s*\(/, "same reason");
});

test("GET /s is refused -- the app is not reachable without a POSTed launch", async () => {
  await assertDenied(await fetch(`${BASE}/s`), "GET /s");
});

test("a launch with surrounding whitespace still validates", async () => {
  // A transport that appends a newline must not read as a forged launch.
  const res = await post("\n" + mintInitData({ userId: ALLOWED_ID }) + "\n");
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});

test("there is no OTHER endpoint to find", async () => {
  for (const p of ["/payload.json", "/week", "/api/week", "/app.html", "/src/app.html", "/.dev.vars"]) {
    const res = await fetch(`${BASE}${p}`);
    const body = await res.text();
    assert.equal(res.status, 404, `${p} should 404`);
    assert.equal(body.length, 0, `${p} should return nothing`);
  }
});

// ── fail-closed: a Worker missing its access-control secret must refuse EVERYONE ───────────
//
// This is the failure that makes an app public by accident: someone deploys, forgets a
// `wrangler secret put`, and an unset allowlist reads as "no restriction". Proving it needs a
// launch that is otherwise perfectly valid -- a bad one would 401 for the wrong reason and the
// test would pass while proving nothing.
test("with ALLOWED_USER_ID unset, a VALID launch for Calvin is still refused", async () => {
  const port = PORT + 2;
  const child = spawn("npx", ["--yes", "wrangler@4.127.1", "dev", "--local", "--port", String(port),
    "--inspector-port", "0", "--var", "ALLOWED_USER_ID:"],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", () => {}); child.stderr.on("data", () => {});
  try {
    const deadline = Date.now() + 90_000;
    for (;;) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
        if (r.status === 200) { await r.text(); break; }
      } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error("second wrangler dev did not come up");
      await new Promise((r) => setTimeout(r, 500));
    }
    // Sanity: the same launch is accepted by the correctly-configured server on PORT.
    const good = await post(mintInitData({ userId: ALLOWED_ID }));
    assert.equal(good.status, 200, "control: this launch must be accepted when the id IS configured");
    await good.text();

    const res = await fetch(`http://127.0.0.1:${port}/s`, {
      method: "POST", body: mintInitData({ userId: ALLOWED_ID }),
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
    });
    await assertDenied(res, "unconfigured worker");
  } finally {
    child.kill("SIGTERM");
  }
});
