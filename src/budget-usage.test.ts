import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { priced, scoreArgs } from "./testing/budget.js";
import { writeCase } from "./testing/runs.js";
import { fakeHarness, readResults, sandbox } from "./testing/sandbox.js";
import { plantSuite, SUMMARY, startsOf } from "./testing/suite.js";

const PARTIAL = 4;
const USAGE = 2;
const RESULTS = "results";
const MAX_COST = "--max-cost";
const MAX_DURATION = "--max-duration";
const DURATION_MESSAGE = "maxDuration must be a positive number of minutes";
const RETRIES_MESSAGE = "retries must be a non-negative integer";
const COST_MESSAGE = "maxCost must be a positive number of US dollars";

test("--max-cost is a usage error for a harness that reports no cost", async () => {
  const box = sandbox();
  plantSuite(box, ["alpha"]);
  const out = path.join(box.root, RESULTS);
  const ran = await box.cli(
    scoreArgs(box, RESULTS, "--harness", "codex", MAX_COST, "1"),
    { SKILL_EVALS_BIN_CODEX: fakeHarness },
  );
  expect(ran.status).toBe(USAGE);
  expect(ran.stderr).toContain(
    "maxCost needs every harness to report its cost, and codex does not",
  );
  expect(startsOf(box), "no run started").toBe(0);
  expect(fs.existsSync(out)).toBe(false);
  // The same harness runs when no budget is asked for.
  const plain = await box.cli(
    scoreArgs(
      box,
      "results",
      "--harness",
      "codex",
      MAX_DURATION,
      "5",
      "--dry-run",
    ),
    { SKILL_EVALS_BIN_CODEX: fakeHarness },
  );
  expect(plain.status, plain.stderr).toBe(0);
});

test("--max-cost is a usage error when the judge or a decision check cannot report a cost", async () => {
  const box = sandbox();
  writeCase(box, "suite", {
    id: "judged",
    checks: [SUMMARY, { type: "judge", rubric: "Says done." }],
  });
  const cost = [MAX_COST, "1"];
  const api = await box.cli(
    scoreArgs(box, RESULTS, ...cost, "--judge-api", "anthropic"),
    { ANTHROPIC_API_KEY: "k" },
  );
  expect(api.status).toBe(USAGE);
  expect(api.stderr).toContain("maxCost cannot count the judge API");
  const harness = await box.cli(
    scoreArgs(box, RESULTS, ...cost, "--judge-harness", "cursor"),
    { SKILL_EVALS_BIN_CURSOR: fakeHarness },
  );
  expect(harness.status).toBe(USAGE);
  expect(harness.stderr).toContain(
    "maxCost cannot count the judge: cursor reports no cost",
  );

  const other = sandbox();
  writeCase(other, "suite", {
    id: "decided",
    checks: [
      SUMMARY,
      { type: "decision", question: "Is it plain?", expect: "yes" },
    ],
  });
  const decision = await other.cli(
    scoreArgs(
      other,
      "results",
      ...cost,
      "--decision-model",
      "m",
      "--decision-url",
      "http://127.0.0.1:9",
    ),
    { BASETEN_API_KEY: "k" },
  );
  expect(decision.status).toBe(USAGE);
  expect(decision.stderr).toContain("maxCost cannot count decision checks");
  expect(startsOf(box) + startsOf(other)).toBe(0);
});

test.each([
  [[MAX_COST, "0"], COST_MESSAGE],
  [["--max-cost=-1"], COST_MESSAGE],
  [[MAX_COST, "abc"], COST_MESSAGE],
  [[MAX_DURATION, "0"], DURATION_MESSAGE],
  [[MAX_DURATION, "Infinity"], DURATION_MESSAGE],
  [["--retries=-1"], RETRIES_MESSAGE],
  [["--retries", "1.5"], RETRIES_MESSAGE],
  [["--retries", "x"], RETRIES_MESSAGE],
])("%j is a usage error before any run", async (flags, message) => {
  const box = sandbox();
  plantSuite(box, ["alpha"]);
  const ran = await box.cli(scoreArgs(box, RESULTS, ...flags));
  expect(ran.status).toBe(USAGE);
  expect(ran.stderr).toContain(message);
  expect(startsOf(box)).toBe(0);
});

test("the config keys retries, maxCost and maxDuration are the defaults of the flags, and a flag wins", async () => {
  const box = sandbox();
  priced(box, ["alpha", "bravo", "charlie"], 0.4);
  box.write("skill-evals.config.json", {
    maxCost: 0.5,
    retries: 1,
    maxDuration: 60,
  });
  const out = path.join(box.root, RESULTS);
  const configured = await box.cli(scoreArgs(box, RESULTS));
  expect(configured.status, configured.stderr).toBe(PARTIAL);
  expect(readResults(out).records).toHaveLength(2);
  const flagged = await box.cli(scoreArgs(box, "again", MAX_COST, "5"));
  expect(flagged.status, flagged.stderr).toBe(0);
  box.write("skill-evals.config.json", { maxDuration: 0 });
  const bad = await box.cli(scoreArgs(box, "third"));
  expect(bad.status).toBe(USAGE);
  expect(bad.stderr).toContain(DURATION_MESSAGE);
});
