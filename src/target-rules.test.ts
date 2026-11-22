import { expect, test } from "vitest";
import { applicability } from "./applicability.js";
import { loadCases } from "./cases.js";
import claudeCode from "./harnesses/claude-code.js";
import { BLINDING, CASES, play, runWith, scores } from "./testing/target.js";
import { installInPlaceOfClaude, reportingRules } from "./testing/rules.js";

const MATCH = "rule-with-precondition.match";
const RULES = { config: { rules: "rules" } };
const REPORTS = { ...RULES, files: { "fake/report-rules": "" } };

test("rule with a precondition: a prompt that tells the agent nothing about being graded, and a case that needs rules", () => {
  const [found] = loadCases(CASES, "rule-with-precondition");
  expect(found?.prompt).not.toMatch(BLINDING);
  expect(found?.preconditions?.map((one) => one.type)).toEqual([
    "context_injected",
  ]);
  const bare = { ...claudeCode, capabilities: new Set<never>() };
  expect(found && applicability(bare, found)).toMatchObject({
    applicable: false,
    missing: ["rules"],
  });
});

test("rule with a precondition: polling in short steps and replying after the marker scores 1 where the rule was reported", async () => {
  installInPlaceOfClaude(reportingRules);
  const record = await play(MATCH, [], REPORTS);
  expect(scores(record)).toEqual([1, 1]);
  expect(record.preconditions?.map((one) => one.score)).toEqual([1]);
  expect(record.score).toBe(1);
  expect(record.rules?.installed).toEqual([".claude/rules/waiting.md"]);
});

test("rule with a precondition: a sleep over thirty seconds fails its check and nothing else", async () => {
  installInPlaceOfClaude(reportingRules);
  const record = await play("rule-with-precondition.long-sleep", [], REPORTS);
  expect(scores(record)).toEqual([0, 1]);
  expect(record.score).toBe(0.5);
});

test("rule with a precondition: a reply before the marker was seen fails the grader", async () => {
  installInPlaceOfClaude(reportingRules);
  const record = await play("rule-with-precondition.early-reply", [], REPORTS);
  expect(scores(record)).toEqual([1, 0]);
  expect(record.checks[1]?.reason).toMatch(/came before the marker was seen/);
});

test("rule with a precondition: where the rule never reached the model the run is invalid, not a zero, and the grader does not run", async () => {
  // The real adapter installs the rule and its stream reports none, so the text cannot be shown to have arrived.
  const ran = await runWith(MATCH, RULES);
  // Exit code 3: invalid runs above `--max-invalid`.
  expect(ran.status).toBe(3);
  const [record] = ran.records;
  expect(record?.score).toBeNull();
  expect(record?.preconditions?.map((one) => one.score)).toEqual([0]);
  expect(record?.checks[1]).toMatchObject({
    score: null,
    reason:
      "not run, because precondition not met: context_injected /30 seconds/ source rules",
  });
  // With no rules named at all the harness reports none either.
  installInPlaceOfClaude(reportingRules);
  const without = await runWith(MATCH, {
    files: REPORTS.files,
  });
  expect(without.records[0]?.score).toBeNull();
  expect(without.records[0]?.rules).toBeUndefined();
});
