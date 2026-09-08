// The suite's own size, asserted against the three documents that print it.
//
// README.md, CONTRIBUTING.md and CLAUDE.md each state how many tests there are, independently, and
// until now nothing reconciled them with the suite or with each other. They drifted BOTH ways a
// reader cannot see:
//
//   #34 -- all three disagreed at once (125, 178, 179). The README's 125 predated the browser way
//         in entirely, so it had been wrong for a whole feature.
//   #35 -- all three agreed at 179 while the suite ran 180, within an hour of #34 landing.
//
// The second is the one that matters for the design here: three files agreeing proves nothing, so
// a test that only compared them to each other would have passed straight through it. The number
// has to come from the suite.
//
// 🔴 THE COUNT IS STATIC, AND THAT IS A REAL LIMITATION, NOT A SHORTCUT. A test cannot run the
// suite it belongs to, so this counts `test(` declarations instead. That equals the figure
// `node --test` prints only while every test is a top-level `test()` call -- which is true today
// (180 declarations, `tests 180`, `suites 0`) and would stop being true the moment someone reaches
// for `describe()` or a subtest. So the assumption is ASSERTED rather than trusted; see the third
// test. If that one fails, this file is measuring the wrong thing and the number it pins is no
// longer the suite's size.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const TEST_FILES = readdirSync(`${ROOT}/test`)
  .filter((f) => f.endsWith(".test.mjs"))
  .sort();

const read = (path) => readFileSync(`${ROOT}/${path}`, "utf8");

// Built fresh per call: a shared /g/ regex carries `lastIndex` between uses and would silently
// undercount on the second file.
const declarations = (src) => src.match(/^\s*(?:await\s+)?test\(/gm) ?? [];

const SUITE_SIZE = TEST_FILES.reduce((n, f) => n + declarations(read(`test/${f}`)).length, 0);

// Each document says it in its own words, so each gets its own pattern rather than one loose one.
// ⚠️ CONTRIBUTING.md also contains "47 tests, 47 pass" -- deliberately, as an illustration of the
// REPORTING FORMAT for a PR body, not a claim about this suite. These patterns must not match it,
// which is why they are anchored on the surrounding prose instead of on `(\d+) tests`.
const DOCUMENTS = [
  { file: "README.md", pattern: () => /The whole suite, (\d+) tests/g },
  { file: "CONTRIBUTING.md", pattern: () => /The whole suite, (\d+) tests/g },
  { file: "CLAUDE.md", pattern: () => /`npm test` \((\d+) tests\)/g },
];

// 🔴 THE ASSERTION IS `deepEqual` AGAINST A ONE-ELEMENT ARRAY, AND THAT IS THE LOAD-BEARING PART.
// The obvious form -- find the number, compare it -- passes vacuously when the pattern matches
// NOTHING, so rewording a line would silently disarm this check instead of failing it. Comparing
// the whole match list against exactly `[SUITE_SIZE]` makes all three ways of going wrong fail:
// no match, the wrong number, and a second mention that would later drift on its own.
//
// An earlier draft of this file asserted the "exactly one match" half as its own test. The
// mutation check retired it: no mutation could fail it alone -- a document reading 182 while the
// suite has 183 satisfies it perfectly -- so it was a control that could not fail, which this
// repo has twice recorded as worse than none.
test("every document that prints the suite's size prints the size the suite actually is", () => {
  for (const { file, pattern } of DOCUMENTS) {
    const found = [...read(file).matchAll(pattern())].map((m) => Number(m[1]));
    assert.deepEqual(
      found,
      [SUITE_SIZE],
      `${file} states ${found.join(", ") || "no"} test(s); the suite has ${SUITE_SIZE}. ` +
        `If the wording changed, update the pattern in this file -- do not delete the check.`,
    );
  }
});

// The static count's own precondition. Asserted, because a counter that quietly stops matching
// the runtime is worse than no counter: it would pin all three documents to a confident wrong
// number, which is a more durable version of the bug this file exists to prevent.
test("the count's assumption holds -- every test is a flat, top-level declaration", () => {
  for (const file of TEST_FILES) {
    const src = read(`test/${file}`);
    assert.equal(
      /^\s*(?:describe|suite|it)\(/m.test(src),
      false,
      `test/${file} introduces a grouping construct. Node then reports subtests and suites, ` +
        `and the declaration count in this file stops equalling the number node prints.`,
    );
    assert.equal(
      /\bt\.test\(/.test(src),
      false,
      `test/${file} declares a subtest. Same consequence: the static count no longer matches.`,
    );
  }
});
