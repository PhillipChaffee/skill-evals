import { expect, test } from "vitest";
import type { Outcome, RuledCheck } from "./index.js";
import { CHECKS, checkScore } from "./index.js";
import { withDefaults } from "./defaults.js";
import { FIELDS } from "./fields.js";
import { call, hook, played, result } from "../testing/transcript.js";
import { bareOutcome, dirsWith } from "../testing/outcome.js";
import { NOT_REPORTED } from "../harnesses/shared.js";

/** One check and a run that tells a wrong default from the right one. */
type Scenario = [check: Record<string, unknown>, outcome: () => Outcome];

const shell = (output: string, id: string) => [
  call("Bash", { command: `run ${id}` }, id),
  result(id, output),
];
const twoOutputs = () => played(...shell("bad", "a"), ...shell("ok", "b"));
const textInOutput = () => played(...shell("zzz", "a"));
const filesAB = () =>
  dirsWith({ "a.txt": "a\n", "b.txt": "b\n", "x.txt": "a\nb\n" }).run();
const load = (via: "skill_tool" | "file_read" | "shell_read"): Outcome =>
  bareOutcome({
    skillEvents: [{ skill: "s", via, index: 0, resolved: true, type: "load" }],
  });

// A run and a check for each rule-scored type, built so that the default of each field it applies changes the verdict
// when it is wrong: the table is the proof that `withDefaults` and the rule read one default.
const SCENARIOS: Record<string, Scenario> = {
  skill_loaded: [{ skill: "s" }, () => load("file_read")],
  skill_not_loaded: [{ skill: "s" }, () => load("shell_read")],
  skill_available: [{ skill: "s" }, () => bareOutcome()],
  skill_not_available: [{ skill: "s" }, () => bareOutcome()],
  skill_file_read: [{ skill: "s", path: "*.md" }, () => load("file_read")],
  output_matches: [{ pattern: "a" }, () => bareOutcome({ finalText: "a" })],
  output_lacks: [{ pattern: "a" }, () => bareOutcome({ finalText: "a" })],
  output_contains: [{ text: "a" }, () => bareOutcome({ finalText: "a" })],
  output_not_contains: [{ text: "a" }, () => bareOutcome({ finalText: "a" })],
  file_exists: [{ path: "a.txt" }, filesAB],
  file_matches: [{ path: "*.txt", pattern: "a" }, filesAB],
  file_lacks: [{ path: "*.txt", pattern: "a" }, filesAB],
  file_lines: [{ path: "a.txt", min: 1 }, filesAB],
  file_absent: [{ path: "nope.txt" }, filesAB],
  file_unchanged: [{ path: "a.txt" }, filesAB],
  file_changed: [{ path: "a.txt" }, filesAB],
  files_changed_only: [{ allow: ["a.txt"] }, filesAB],
  file_count: [{ path: "*.md" }, filesAB],
  dir_exists: [{ path: "nope" }, filesAB],
  tool_called: [{ name: "Read", max: 0 }, () => bareOutcome()],
  tool_not_called: [{ name: "Bash" }, twoOutputs],
  first_tool: [{ matches: { name: "Bash" } }, twoOutputs],
  agent_dispatched: [{ agent: "x", max: 0 }, () => bareOutcome()],
  asked_user: [{ max: 0 }, () => bareOutcome()],
  ended_awaiting_user: [{}, () => bareOutcome()],
  tool_order: [
    { before: { name: "Bash" }, after: { name: "Bash" } },
    twoOutputs,
  ],
  transcript_matches: [{ pattern: "zzz" }, textInOutput],
  transcript_lacks: [{ pattern: "zzz" }, textInOutput],
  tool_output_matches: [{ tool: { kind: "shell" }, pattern: "ok" }, twoOutputs],
  tool_output_lacks: [{ tool: { kind: "shell" }, pattern: "bad" }, twoOutputs],
  tool_output_size: [{ maxBytes: 1 }, twoOutputs],
  subject_unchanged: [{}, () => bareOutcome()],
  hook_fired: [{ event: "SessionStart", max: 0 }, () => bareOutcome()],
  // Only a rule text that the harness reported matches, so a default source of "hooks" would score 0.
  context_injected: [
    { pattern: "keep" },
    () =>
      bareOutcome({
        ...played(hook("SessionStart", { context: "other" })),
        loaded: { ...NOT_REPORTED, ruleTexts: ["keep it short"] },
      }),
  ],
  command: [{ run: "exit 3" }, () => dirsWith().run()],
};
// Scored by a model: no rule reads a default, and the judge and decision paths take theirs from the same table.
const MODEL = ["judge", "decision"];

test("every check type has a scenario or is scored by a model", () => {
  expect(Object.keys(CHECKS).sort()).toEqual(
    [...Object.keys(SCENARIOS), ...MODEL].sort(),
  );
  for (const type of MODEL) expect(CHECKS[type]?.rule).toBeUndefined();
});

test.each(Object.entries(SCENARIOS))(
  "%s: the rule and withDefaults agree",
  async (type, [fields, outcome]) => {
    const plain = { type, weight: 1, ...fields } as RuledCheck;
    const filled = withDefaults(plain, CHECKS[type]);
    const bare = await checkScore(plain, outcome());
    const explicit = await checkScore(filled, outcome());
    // A command's duration differs from one run to the next.
    const stable = (verdict: { score: number; reason?: string }) => ({
      score: verdict.score,
      reason: verdict.reason?.replace(/\d+ ms/, "<n> ms"),
    });
    expect(stable(explicit)).toEqual(stable(bare));
  },
);

test("a default that the rule does not apply fails the agreement, as a drift would", async () => {
  // The rule of file_lacks applies "all"; a table that said "any" would score this run 1 where the rule scores 0.
  const check = { type: "file_lacks", weight: 1, path: "*.txt", pattern: "a" };
  const [, outcome] = SCENARIOS["file_lacks"] ?? [];
  const bare = await checkScore(check as RuledCheck, outcome?.() as Outcome);
  const drifted = await checkScore(
    { ...check, quantifier: "any" } as RuledCheck,
    outcome?.() as Outcome,
  );
  expect(drifted.score).not.toBe(bare.score);
});

test("withDefaults fills the defaults that its table names, and only for fields the type takes", () => {
  const spec = (type: string) => CHECKS[type];
  const filled = withDefaults(
    {
      type: "tool_order",
      weight: 1,
      before: { name: "a" },
      after: { name: "b", which: "last" },
    },
    spec("tool_order"),
  );
  expect(filled).toMatchObject({
    before: { name: "a", which: "first" },
    after: { which: "last" },
    strict: false,
    ifUnsupported: "not-applicable",
  });
  expect(filled).not.toHaveProperty("sequence");
  expect(
    withDefaults(
      { type: "tool_not_called", name: "a" },
      spec("tool_not_called"),
    ),
  ).toMatchObject({ min: 0, max: 0 });
  expect(
    withDefaults({ type: "skill_loaded", skill: "s" }, spec("skill_loaded")),
  ).toMatchObject({
    via: ["skill_tool", "file_read", "shell_read"],
    first: false,
  });
  expect(
    withDefaults(
      { type: "judge", rubric: "r", sees: ["transcript"] },
      spec("judge"),
    ),
  ).toMatchObject({ scale: "0-1", votes: 1, maxChars: 60_000 });
  expect(
    withDefaults({ type: "judge", rubric: "r" }, spec("judge")),
  ).not.toHaveProperty("maxChars");
  expect(withDefaults({ type: "x" }, undefined)).toMatchObject({ type: "x" });
});

test("every default of FIELDS names check types that exist", () => {
  for (const [field, def] of Object.entries(FIELDS)) {
    for (const type of Object.keys(def.default?.value ?? {})) {
      expect(type === "*" || type in CHECKS, `${field}: ${type}`).toBe(true);
    }
  }
});
