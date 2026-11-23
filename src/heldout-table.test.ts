import path from "node:path";
import { expect, test } from "vitest";
import { requireApproved } from "./approval.js";
import { rootsOf } from "./case-roots.js";
import { exclusionsOf } from "./exclusions.js";
import { gapText, triggerTable } from "./report/trigger.js";
import { sandbox } from "./testing/sandbox.js";
import { loads, plantRoot } from "./testing/roots.js";
import { caseOf, evaluationOf, runOf } from "./testing/trigger-eval.js";

const HARNESS = "h";
const ONE_RUN = "1.00 (1 run)";
const NO_RUNS = "n/a (0 runs)";

test("a check without a skill counts for the targets of its case, and an invalid run counts for nothing", () => {
  const cases = [
    caseOf("t", { kind: "trigger", targets: ["a", "b"] }),
    caseOf("n", { kind: "negative", targets: ["a"] }),
  ];
  const table = triggerTable(
    evaluationOf([HARNESS], cases, [
      runOf({ caseId: "t", harness: HARNESS }, [
        { type: "skill_loaded", score: 1 },
      ]),
      runOf(
        { caseId: "t", harness: HARNESS },
        [{ type: "skill_loaded", score: 0 }],
        "crashed",
      ),
      runOf({ caseId: "n", harness: HARNESS }, [
        { type: "skill_not_loaded", score: 0 },
      ]),
      runOf({ caseId: "n", harness: HARNESS }, [
        { type: "skill_not_loaded", score: null },
      ]),
    ]),
  );
  expect(table?.head).toEqual([
    "skill",
    "trigger recall (dev)",
    "trigger recall (held-out)",
    "gap",
    "false-trigger rate",
  ]);
  expect(table?.body).toEqual([
    ["a", ONE_RUN, NO_RUNS, "n/a", ONE_RUN],
    ["b", ONE_RUN, NO_RUNS, "n/a", NO_RUNS],
  ]);
});

test("with more than one harness the table has a row for each, and a case with no targets gives no table", () => {
  const cases = [caseOf("t", { kind: "trigger", targets: ["a"] })];
  const records = [
    runOf({ caseId: "t", harness: "h1" }, [
      { type: "skill_loaded", skill: "a", score: 1 },
    ]),
    runOf({ caseId: "t", harness: "h2" }, [
      { type: "skill_loaded", skill: "a", score: 0.5 },
    ]),
  ];
  const table = triggerTable(evaluationOf(["h1", "h2"], cases, records));
  expect(table?.head[0]).toBe("harness");
  expect(table?.body.map(([harness, , dev]) => [harness, dev])).toEqual([
    ["h1", ONE_RUN],
    ["h2", "0.50 (1 run)"],
  ]);
  expect(
    triggerTable(evaluationOf([HARNESS], [caseOf("t", {})], [])),
  ).toBeNull();
});

test("the gap has a sign, and a difference that rounds to nothing is 0.00", () => {
  expect(gapText(0.25)).toBe("+0.25");
  expect(gapText(-0.3)).toBe("-0.30");
  expect(gapText(-0.0001)).toBe("0.00");
  expect(gapText(0)).toBe("0.00");
  expect(gapText(null)).toBe("n/a");
});

test("roots are named by the cases directories first, and a single one needs no prefix", () => {
  expect(rootsOf({ cases: ["/a/one"] })).toEqual([
    { dir: "/a/one", heldout: false },
  ]);
  expect(rootsOf({ cases: ["/a/one"], heldoutCases: ["/b/two"] })).toEqual([
    { dir: "/a/one", heldout: false },
    { dir: "/b/two", heldout: true },
  ]);
  expect(exclusionsOf({ cases: ["/a/one"] }, "/").cases).toEqual(["/a/one"]);
});

test("the approval prompt names every root, and shows a held-out root with its own flag", async () => {
  const box = sandbox();
  const dev = plantRoot(box, "dev", { a: { checks: loads("bro") } });
  const held = plantRoot(box, "held", { b: { checks: loads("bro") } });
  const env = { SKILL_EVALS_STATE_DIR: path.join(box.root, "state") };
  const terminal = { interactive: false, ask: () => Promise.resolve("") };
  const refused = requireApproved(
    { casesDirs: [dev, held], heldoutDirs: [held], count: 2 },
    { terminal, env },
  );
  await expect(refused).rejects.toThrow(
    `skill-evals list --cases ${dev} --heldout-cases ${held} --heldout --show-prompts`,
  );
  await expect(refused).rejects.toThrow(
    `${dev}, ${held} has not been approved`,
  );
});
