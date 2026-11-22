import path from "node:path";
import { expect, test } from "vitest";
import { play } from "./testing/runs.js";
import { readResults, sandbox, tableRow } from "./testing/sandbox.js";

const CLAUDE_CODE = "claude-code";
const NEEDS_MCP = "needs-mcp";
const SUBJECT_FLAGS = ["score", "--subject", "none", "--reps", "1"];
const MISSING_BIN = "bin:definitely-missing";
const MCP = "mcp";
const PROMPT_SEEN = { type: "output_contains", text: "prompt" };
const NEVER_SEEN = { type: "output_contains", text: "no such text" };
const SKIPPABLE = { ...NEVER_SEEN, requires: [MCP], ifUnsupported: "skip" };
const BAR = 0.9;

/**
 * Plants cases and scores them with the fake harness.
 * @param planted - Each case's id and the keys of its case file.
 * @param flags - More flags of the `score` command.
 * @param env - More environment variables of the command line.
 * @returns The sandbox, the command's result, and `results.json` when it was written.
 */
async function scored(
  planted: Record<string, Record<string, unknown>>,
  flags: string[] = [],
  env: Record<string, string> = {},
) {
  const box = sandbox();
  for (const [id, keys] of Object.entries(planted)) {
    box.write(`cases/${id}/prompt.md`, `do ${id}\n`);
    box.write(`cases/${id}/case.json`, keys);
  }
  const out = path.join(box.root, "results");
  const ran = await box.cli(
    [
      ...SUBJECT_FLAGS,
      ...["--out", out],
      ...["--cases", path.join(box.root, "cases"), ...flags],
    ],
    env,
  );
  const results = ran.status === 2 ? null : readResults(out);
  return { box, ran, results };
}

test("a case that requires a missing capability has no run and no score", async () => {
  const { ran, results } = await scored({
    plain: { checks: [PROMPT_SEEN, NEVER_SEEN] },
    [NEEDS_MCP]: { requires: [MCP], checks: [PROMPT_SEEN] },
  });
  expect(ran.status, ran.stderr).toBe(0);
  expect(results?.records.map((record) => record.caseId)).toEqual(["plain"]);
  expect(results?.notApplicable).toHaveLength(1);
  expect(results?.notApplicable[0]?.missing).toEqual([MCP]);
  expect(results?.notApplicable[0]?.caseId).toBe(NEEDS_MCP);
  expect(results?.suites[0]?.suite["subject"]).toBe(0.5);
  expect(results?.suites[0]?.cases.map((c) => c.id)).toEqual(["plain"]);
  expect(ran.stdout).toMatch(/## Not applicable[\s\S]*needs-mcp[\s\S]*mcp/);
});

test("an unknown capability name is a load error that lists the known names", async () => {
  const wrong = await scored({
    odd: { requires: ["telepathy"], checks: [PROMPT_SEEN] },
  });
  expect(wrong.ran.status).toBe(2);
  expect(wrong.ran.stderr).toMatch(
    /unknown capability "telepathy"; known: subagents, multiTurn/,
  );
  const inCheck = await scored({
    odd: { checks: [{ ...PROMPT_SEEN, requires: ["telepathy"] }] },
  });
  expect(inCheck.ran.stderr).toMatch(/unknown capability "telepathy"/);
  const badBin = await scored({
    odd: { requires: ["bin:"], checks: [PROMPT_SEEN] },
  });
  expect(badBin.ran.stderr).toMatch(/unknown capability "bin:"/);
  const notList = await scored({
    odd: { requires: MCP, checks: [PROMPT_SEEN] },
  });
  expect(notList.ran.stderr).toMatch(/"requires" must be a list/);
});

test("a missing executable makes the case not applicable, and the name is the reason", async () => {
  const { ran, results } = await scored({
    plain: { checks: [PROMPT_SEEN] },
    tooled: { requires: [MISSING_BIN], checks: [PROMPT_SEEN] },
    git: { requires: ["bin:git"], checks: [PROMPT_SEEN] },
  });
  expect(ran.status, ran.stderr).toBe(0);
  expect(results?.notApplicable.map((entry) => entry.caseId)).toEqual([
    "tooled",
  ]);
  expect(results?.notApplicable[0]?.missing).toEqual([MISSING_BIN]);
  expect(results?.notApplicable[0]?.reason).toMatch(/bin:definitely-missing/);
  expect(results?.records.map((record) => record.caseId).sort()).toEqual([
    "git",
    "plain",
  ]);
});

test("ifUnsupported skip drops one check, re-normalizes, and is reported", async () => {
  const { ran, results } = await scored({
    two: { checks: [PROMPT_SEEN, SKIPPABLE] },
    "all-skipped": { checks: [SKIPPABLE] },
  });
  expect(ran.status, ran.stderr).toBe(0);
  const [record] = results?.records ?? [];
  expect(record?.checks).toHaveLength(1);
  expect(record?.score).toBe(1);
  expect(results?.skippedChecks).toEqual([
    {
      harness: CLAUDE_CODE,
      caseId: "two",
      checks: ['output_contains "no such text"'],
      missing: [MCP],
    },
  ]);
  expect(results?.notApplicable.map((entry) => entry.caseId)).toEqual([
    "all-skipped",
  ]);
  expect(ran.stdout).toMatch(/## Ran with checks skipped[\s\S]*two/);
  expect(ran.stdout).toContain('output_contains "no such text"');
});

test("a skipped first check leaves the per-check lines of the report aligned", async () => {
  const { ran, results } = await scored({
    three: { checks: [SKIPPABLE, PROMPT_SEEN, NEVER_SEEN] },
  });
  expect(results?.records[0]?.checks.map((check) => check.score)).toEqual([
    1, 0,
  ]);
  const row = tableRow(ran.stdout, "three");
  expect(row).toContain('`output_contains "prompt"` 1/1');
  expect(row).toContain('`output_contains "no such text"` 0/1');
});

test("harnesses without a note is a load error, and the note is the reason elsewhere", async () => {
  const bare = await scored({
    only: { harnesses: ["pi"], checks: [PROMPT_SEEN] },
  });
  expect(bare.ran.status).toBe(2);
  expect(bare.ran.stderr).toMatch(/"harnesses" needs a "note"/);
  const unknown = await scored({
    only: { harnesses: ["vim"], note: "x", checks: [PROMPT_SEEN] },
  });
  expect(unknown.ran.stderr).toMatch(/unknown harness "vim"; known: pi/);

  const { results } = await scored({
    plain: { checks: [PROMPT_SEEN] },
    only: {
      harnesses: ["pi"],
      note: "pi has the only fixture",
      checks: [PROMPT_SEEN],
    },
  });
  expect(results?.notApplicable[0]).toEqual({
    harness: CLAUDE_CODE,
    caseId: "only",
    missing: [],
    reason: "pi has the only fixture",
  });
});

test("the suite line shows the applicable count, and a bar of a not applicable case does not apply", async () => {
  const { ran, results } = await scored({
    plain: { checks: [PROMPT_SEEN] },
    [NEEDS_MCP]: { requires: [MCP], minScore: BAR, checks: [NEVER_SEEN] },
  });
  expect(ran.stdout).toMatch(
    /Suite score: 1\.00 \(1 of 2 cases, 1 of 1 runs\)/,
  );
  expect(results?.suites[0]).toMatchObject({ applicable: 1, total: 2 });
  expect(results?.belowBar).toEqual([]);
  expect(ran.status).toBe(0);
});

test("no case applying to any chosen harness is a usage error", async () => {
  const { ran } = await scored({
    [NEEDS_MCP]: { requires: [MCP], checks: [PROMPT_SEEN] },
  });
  expect(ran.status).toBe(2);
  expect(ran.stderr).toMatch(/no case applies to claude-code/);
});

test("two harnesses with different applicable sets get a common-set score", async () => {
  const box = sandbox();
  const planted = {
    plain: { checks: [PROMPT_SEEN] },
    half: { checks: [PROMPT_SEEN, NEVER_SEEN] },
    children: { requires: ["childCalls"], checks: [PROMPT_SEEN] },
  };
  for (const [id, keys] of Object.entries(planted)) {
    box.write(`cases/${id}/prompt.md`, `do ${id}\n`);
    box.write(`cases/${id}/case.json`, keys);
  }
  const out = path.join(box.root, "results");
  const ran = await box.cli(
    [
      ...SUBJECT_FLAGS,
      ...["--out", out],
      ...["--cases", path.join(box.root, "cases")],
      ...["--harness", `${CLAUDE_CODE},pi`],
    ],
    { SKILL_EVALS_BIN_PI: box.pi },
  );
  expect(ran.status, ran.stderr).toBe(0);
  const results = readResults(out);
  const byHarness = Object.fromEntries(
    results.suites.map((suite) => [suite.harness, suite]),
  );
  expect(byHarness[CLAUDE_CODE]).toMatchObject({ applicable: 3, total: 3 });
  expect(byHarness["pi"]).toMatchObject({ applicable: 2, total: 3 });
  expect(results.commonSet).toEqual({
    cases: ["half", "plain"],
    suite: {
      [CLAUDE_CODE]: { subject: 0.75 },
      pi: { subject: 0.75 },
    },
    runs: {
      [CLAUDE_CODE]: { subject: { valid: 2, planned: 2 } },
      pi: { subject: { valid: 2, planned: 2 } },
    },
  });
  expect(ran.stdout).toMatch(/Common set \(2 cases: half, plain\)/);
  expect(ran.stdout).toMatch(/Suite score: .* \(2 of 3 cases, 2 of 2 runs\)/);
});

test("a harness with no applicable case gets a report line and no score, and one harness alone has no common set", async () => {
  const box = sandbox();
  box.write("cases/children/prompt.md", "do children\n");
  box.write("cases/children/case.json", {
    requires: ["childCalls"],
    checks: [PROMPT_SEEN],
  });
  const out = path.join(box.root, "results");
  const ran = await box.cli(
    [
      ...SUBJECT_FLAGS,
      ...["--out", out],
      ...["--cases", path.join(box.root, "cases")],
      ...["--harness", `${CLAUDE_CODE},pi`, "--min-score", "0.5"],
    ],
    { SKILL_EVALS_BIN_PI: box.pi },
  );
  expect(ran.status, ran.stderr).toBe(0);
  const results = readResults(out);
  expect(ran.stdout).toContain("no case applies to pi: 1 cases not applicable");
  expect(results.suites.find((s) => s.harness === "pi")).toMatchObject({
    applicable: 0,
    total: 1,
    suite: { subject: null },
  });
  expect(results.commonSet).toBeNull();
  expect(results.belowBar).toEqual([]);
});

test("the pi-shaped fake plays scripts, so a scripted call is seen in both harnesses", async () => {
  const box = sandbox();
  box.write("cases/ran/prompt.md", "do ran\n");
  box.write("cases/ran/case.json", {
    checks: [
      { type: "tool_called", name: "^[Bb]ash$" },
      { type: "output_contains", text: "done" },
    ],
  });
  play(box, {
    name: "ran",
    id: "ran",
    steps: [
      { call: { name: "Bash", input: { command: "ls" } } },
      { text: "working" },
    ],
  });
  const out = path.join(box.root, "results");
  const ran = await box.cli(
    [
      ...SUBJECT_FLAGS,
      ...["--out", out],
      ...["--cases", path.join(box.root, "cases")],
      ...["--harness", `${CLAUDE_CODE},pi`],
    ],
    { SKILL_EVALS_BIN_PI: box.pi },
  );
  expect(ran.status, ran.stderr).toBe(0);
  const scores = readResults(out).records.map((r) => [r.harness, r.score]);
  expect(scores).toEqual([
    ["claude-code", 1],
    ["pi", 1],
  ]);
});
