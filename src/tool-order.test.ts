import path from "node:path";
import { expect, test } from "vitest";
import { plantCase, script, skillsFolder } from "./testing/plant.js";
import type { FakeScript } from "./testing/plant.js";
import { scoreSubject } from "./testing/runs.js";
import { readResults, sandbox } from "./testing/sandbox.js";

type Steps = FakeScript["turns"][number];

const bash = (command: string) => ({
  call: { name: "Bash", input: { command } },
});
const edit = (file: string) => ({
  call: { name: "Edit", input: { file_path: file } },
});
const read = (file: string) => ({
  call: { name: "Read", input: { file_path: file } },
});
const skill = (name: string) => ({
  call: { name: "Skill", input: { skill: name } },
});
const agent = (type: string) => ({
  call: { name: "Agent", input: { subagent_type: type, prompt: "go" } },
});
const RESEARCHER = { kind: "subagent", inputMatches: "researcher" };
const SYNTHESIZER = { kind: "subagent", inputMatches: "synthesizer" };
const ENTRY = "magic-mode";
const ADAPTER_DOC = "harness-adapter.md";
const NPM_TEST = { kind: "shell", inputMatches: "npm test" };

/**
 * Plays one scripted agent and scores one planted case on it.
 * @param steps - What the agent does.
 * @param checks - The checks of the case.
 * @returns The score and reason of each check, in order.
 */
async function scored(steps: Steps, checks: unknown[]) {
  const box = sandbox();
  script(box, "run", { turns: [[...steps, { final: "done" }]] });
  const ran = await scoreSubject(box, {
    subject: skillsFolder(box, "skills", { bro: "# bro\n" }),
    cases: plantCase(box, checks),
  });
  expect(ran.status, ran.stderr).toBe(0);
  return (ran.records[0]?.checks ?? []).map(({ score, reason }) => ({
    score,
    reason,
  }));
}

test("exactly one synthesizer: two matching calls fail max 1 and say how many", async () => {
  const [verdict] = await scored(
    [agent("synthesizer"), agent("synthesizer")],
    [{ type: "tool_called", ...SYNTHESIZER, min: 1, max: 1 }],
  );
  expect(verdict?.score).toBe(0);
  expect(verdict?.reason).toMatch(/2 matching calls.*max 1/);
  expect(verdict?.reason).toContain("#0 t1 main subagent Agent");
});

test("a count that holds has no reason, and a count below min says so", async () => {
  const [held, short] = await scored(
    [agent("synthesizer")],
    [
      { type: "tool_called", ...SYNTHESIZER, min: 1, max: 1 },
      { type: "tool_called", ...SYNTHESIZER, min: 2 },
    ],
  );
  expect(held).toEqual({ score: 1, reason: undefined });
  expect(short?.reason).toMatch(/1 matching call, min 2/);
});

test("a failing check run precedes the first source edit and follows the last", async () => {
  const steps = [bash("npm test"), edit("src/a.ts"), bash("npm test")];
  const checks = [
    {
      type: "tool_order",
      before: NPM_TEST,
      after: { kind: "edit", inputMatches: "src/" },
    },
    {
      type: "tool_order",
      before: { kind: "edit", which: "last" },
      after: { ...NPM_TEST, which: "last" },
    },
  ];
  const full = await scored(steps, checks);
  expect(full.map((one) => one.score)).toEqual([1, 1]);
  const cut = await scored(steps.slice(0, 2), checks);
  expect(cut[0]?.score).toBe(1);
  expect(cut[1]?.score).toBe(0);
  expect(cut[1]?.reason).toMatch(
    /the last edit call #1 is not before the last shell call #0/,
  );
});

test("an order check says which side has no match", async () => {
  const [verdict] = await scored(
    [edit("src/a.ts")],
    [{ type: "tool_order", before: NPM_TEST, after: { kind: "edit" } }],
  );
  expect(verdict?.score).toBe(0);
  expect(verdict?.reason).toMatch(/no call matches "before"/);
  expect(verdict?.reason).toContain("#0 t1 main edit Edit");
});

test("a first-tool check ignores an allowlisted read and fails on any other", async () => {
  const check = {
    type: "first_tool",
    matches: { kind: "skill", inputMatches: ENTRY },
    ignoring: [{ kind: "read", inputMatches: "harness-adapter" }],
  };
  const [allowed] = await scored([read(ADAPTER_DOC), skill(ENTRY)], [check]);
  expect(allowed).toEqual({ score: 1, reason: undefined });
  const [other] = await scored([read("src/a.ts"), skill(ENTRY)], [check]);
  expect(other?.score).toBe(0);
  expect(other?.reason).toMatch(/first tool call #0 does not match/);
  const [none] = await scored([read(ADAPTER_DOC)], [check]);
  expect(none?.reason).toMatch(/no tool call is left after ignoring/);
});

test("skill_loaded first needs the first skill load to be the skill, with nothing before it but what is ignored", async () => {
  const ignoring = [{ kind: "read", inputMatches: "harness-adapter" }];
  const checks = [
    { type: "skill_loaded", skill: ENTRY, first: true },
    { type: "skill_loaded", skill: ENTRY, first: true, ignoring },
    {
      type: "skill_loaded",
      anyOf: ["how", ENTRY],
      first: true,
      ignoring,
    },
    { type: "skill_loaded", skill: "how", first: true, ignoring },
  ];
  const results = await scored(
    [read(ADAPTER_DOC), skill(ENTRY), skill("how")],
    checks,
  );
  expect(results.map((one) => one.score)).toEqual([0, 1, 1, 0]);
  expect(results[0]?.reason).toMatch(/#0 t1 main read Read/);
  expect(results[3]?.reason).toMatch(/first skill load is "magic-mode"/);
  const [bare] = await scored([bash("ls")], [checks[0]]);
  expect(bare?.reason).toMatch(/no skill was loaded/);
});

test("skill_loaded anyOf accepts any named skill, and a plain skill_loaded scores as before", async () => {
  const results = await scored(
    [skill("how")],
    [
      { type: "skill_loaded", anyOf: ["research", "how"] },
      { type: "skill_loaded", anyOf: ["research", "why"] },
      { type: "skill_loaded", skill: "how" },
      { type: "skill_loaded", skill: "why" },
      { type: "skill_not_loaded", skill: "how" },
    ],
  );
  expect(results.map((one) => one.score)).toEqual([1, 0, 1, 0, 0]);
  expect(results[1]?.reason).toMatch(/none of research, why was loaded/);
  expect(results[3]?.reason).toMatch(/"why" was not loaded/);
  expect(results[4]?.reason).toMatch(
    /"how" was loaded.*#0 t1 main skill Skill/s,
  );
});

const TWO_THEN_ONE: Steps = [
  { parallel: [agent("researcher"), agent("researcher")] },
  agent("synthesizer"),
];

test("two researchers in one turn, then one synthesizer, none after", async () => {
  const checks = [
    { type: "tool_called", ...RESEARCHER, min: 2, sameTurn: true },
    { type: "tool_called", ...SYNTHESIZER, min: 1, max: 1 },
    { type: "tool_order", sequence: [RESEARCHER, SYNTHESIZER], strict: true },
  ];
  const ok = await scored(TWO_THEN_ONE, checks);
  expect(ok.map((one) => one.score)).toEqual([1, 1, 1]);
  const late = await scored([...TWO_THEN_ONE, agent("researcher")], checks);
  expect(late.map((one) => one.score)).toEqual([0, 1, 0]);
  expect(late[0]?.reason).toMatch(
    /not all issued in one turn: call #3 is in turn 3, call #0 in turn 1/,
  );
  expect(late[0]?.reason).toContain("#3 t3 main subagent Agent");
  expect(late[2]?.reason).toMatch(
    /sequence\[0\] matches call #3 after call #2/,
  );
  const apart = await scored(
    [agent("researcher"), agent("researcher"), agent("synthesizer")],
    checks,
  );
  expect(apart[0]?.score).toBe(0);
  expect(apart[0]?.reason).toMatch(/not all issued in one turn: call #1/);
  const short = await scored([agent("researcher")], checks);
  expect(short[0]?.reason).toMatch(/1 matching call, min 2/);
});

test("a straggler researcher outside the launch turn fails sameTurn with min 2", async () => {
  const [verdict] = await scored(
    [
      { parallel: [agent("researcher"), agent("researcher")] },
      agent("researcher"),
      agent("synthesizer"),
    ],
    [{ type: "tool_called", ...RESEARCHER, min: 2, sameTurn: true }],
  );
  expect(verdict?.score).toBe(0);
  expect(verdict?.reason).toMatch(/call #2 is in turn 2, call #0 in turn 1/);
  expect(verdict?.reason).toContain("#2 t2 main subagent Agent");
});

test("a sequence that is not strict allows repeats and fails when a step is missing or out of order", async () => {
  const check = { type: "tool_order", sequence: [RESEARCHER, SYNTHESIZER] };
  const [repeat] = await scored(
    [...TWO_THEN_ONE, agent("researcher")],
    [check],
  );
  const [missing] = await scored([agent("researcher")], [check]);
  const [swapped] = await scored(
    [agent("synthesizer"), agent("researcher")],
    [check],
  );
  expect(repeat?.score).toBe(1);
  expect(missing?.score).toBe(0);
  expect(missing?.reason).toMatch(
    /sequence\[1\] matches no call after call #0/,
  );
  expect(swapped?.score).toBe(0);
  const strict = await scored(
    [agent("synthesizer"), agent("researcher"), agent("synthesizer")],
    [{ ...check, strict: true }],
  );
  expect(strict[0]?.reason).toMatch(
    /sequence\[1\] matches call #0 before call #1/,
  );
});

test("a tool_called with first needs the first call of the run to fit", async () => {
  const check = { type: "tool_called", kind: "skill", first: true };
  const [yes] = await scored([skill("how"), bash("ls")], [check]);
  const [no] = await scored([bash("ls"), skill("how")], [check]);
  expect(yes?.score).toBe(1);
  expect(no?.score).toBe(0);
  expect(no?.reason).toMatch(/first tool call #0 does not match/);
});

test("tool_not_called keeps its 0.0.1 meaning and a tool_called with no min still means at least one", async () => {
  const results = await scored(
    [bash("npm test")],
    [
      { type: "tool_called", kind: "shell" },
      { type: "tool_called", kind: "edit" },
      { type: "tool_not_called", kind: "shell" },
      { type: "tool_not_called", kind: "edit" },
      { type: "tool_called", kind: "shell", inputMatches: "NPM", flags: "i" },
    ],
  );
  expect(results.map((one) => one.score)).toEqual([1, 0, 0, 1, 1]);
  expect(results[1]?.reason).toMatch(/0 matching calls, min 1/);
  expect(results[2]?.reason).toMatch(/1 matching call, max 0/);
});

test("a matcher's flags apply to its own fields only, and a check's flags to the check's own", async () => {
  const upper = [bash("NPM TEST"), edit("src/A.ts")];
  const results = await scored(upper, [
    {
      type: "tool_order",
      before: { ...NPM_TEST, flags: "i" },
      after: { kind: "edit", inputMatches: "src/A" },
    },
    {
      type: "tool_order",
      before: { kind: "shell", inputMatches: "npm test" },
      after: { kind: "edit", inputMatches: "src/a", flags: "i" },
    },
    {
      type: "tool_order",
      sequence: [
        { ...NPM_TEST, flags: "i" },
        { kind: "edit", inputMatches: "SRC/A" },
      ],
    },
    {
      type: "tool_called",
      kind: "shell",
      inputMatches: "npm test",
      flags: "i",
    },
    { type: "tool_called", kind: "shell", inputMatches: "npm test" },
  ]);
  // Each flag applies to its own matcher: the first pair needs "i" on the shell side only, and the others lack it.
  expect(results.map((one) => one.score)).toEqual([1, 0, 0, 1, 0]);
});

test("sameTurn on a harness without turn grouping makes the case not applicable", async () => {
  const box = sandbox();
  const cases = plantCase(box, [
    { type: "tool_called", kind: "subagent", min: 2, sameTurn: true },
  ]);
  const out = path.join(box.root, "results");
  const ran = await box.cli(
    [
      ...["score", "--subject", "none", "--reps", "1", "--out", out],
      ...["--cases", cases, "--harness", "claude-code,codex"],
    ],
    { SKILL_EVALS_BIN_CODEX: box.pi },
  );
  expect(ran.status, ran.stderr).toBe(0);
  const results = readResults(out);
  const [gap] = results.notApplicable;
  expect(gap?.missing).toEqual(["turnGrouping"]);
  expect(results.records.map((record) => record.harness)).toEqual([
    "claude-code",
  ]);
});
