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
             sessions: [{ kind: "Run · test", title: "A test session", status: "planned" }] }],
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
  method: "POST", headers: { "X-Telegram-Init-Data": initData }, redirect: "manual",
});

async function assertDenied(res, what) {
  const body = await res.text();
  assert.equal(res.status, 401, `${what}: expected 401`);
  assert.equal(body.length, 0, `${what}: expected an EMPTY body, got ${body.length} bytes`);
  assert.equal(res.headers.get("content-type"), null, `${what}: a denial must not declare a content type`);
}

// ── the plan's four cases ──────────────────────────────────────────────────────────────────

test("valid initData for Calvin -> 200 and the app", async () => {
  const res = await post(mintInitData({ userId: ALLOWED_ID }));
  const body = await res.text();
  assert.equal(res.status, 200);
  assert.match(body, /<title>Today<\/title>/);
  assert.match(body, /A test session/, "the app must arrive with the plan already in it");
  assert.match(res.headers.get("content-security-policy") ?? "", /script-src 'nonce-/);
  assert.doesNotMatch(res.headers.get("content-security-policy") ?? "", /unsafe-inline/);
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

test("GET / serves a shell that contains no plan and no design system", async () => {
  const res = await fetch(`${BASE}/`);
  const body = await res.text();
  assert.equal(res.status, 200);
  assert.doesNotMatch(body, /A test session/, "the unauthenticated shell must carry no plan");
  assert.doesNotMatch(body, /leaveBy|oneRule|week-state/, "nor any of the plan's vocabulary");
  assert.doesNotMatch(body, /--sport-run|--progress-track/, "nor the design system");
  assert.ok(body.length < 4096, `the shell should stay tiny; it is ${body.length} bytes`);
});

test("GET /s is refused -- the app is not reachable without a POSTed launch", async () => {
  await assertDenied(await fetch(`${BASE}/s`), "GET /s");
});

test("there is no data endpoint to find", async () => {
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
      method: "POST", headers: { "X-Telegram-Init-Data": mintInitData({ userId: ALLOWED_ID }) },
    });
    await assertDenied(res, "unconfigured worker");
  } finally {
    child.kill("SIGTERM");
  }
});
