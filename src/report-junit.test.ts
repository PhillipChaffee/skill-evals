import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import type { Evaluation } from "./evaluate.js";
import type { JsonReport } from "./report/json.js";
import { renderJunit } from "./report/junit.js";
import { scoreArgs, scriptedCase } from "./testing/budget.js";
import { sandbox } from "./testing/sandbox.js";
import { parseXml, testNamed } from "./testing/xml.js";
import type { XmlElement } from "./testing/xml.js";

const RESULTS = "results";
const REPORT = "report.xml";
const SUITE_SCORE = "suite score";
const JUNIT = "junit";
const SYSTEM_OUT = "system-out";
const NEVER = { type: "output_contains", text: "never said" };
const CRASH_ONCE = [{ onStart: [1], step: { crash: "segfault" } }];
const read = (out: string, file: string): string =>
  fs.readFileSync(path.join(out, file), "utf8");

test("junit has a suite score testcase that fails under --min-score", async () => {
  const box = sandbox();
  scriptedCase(box, "alpha", { checks: [NEVER] });
  const ran = await box.cli(
    scoreArgs(box, RESULTS, "--min-score", "0.9", "--report", JUNIT),
  );
  expect(ran.status, ran.stderr).toBe(1);
  const root = parseXml(read(path.join(box.root, RESULTS), REPORT));
  const suite = root.children[0] as XmlElement;
  expect(suite.attributes).toMatchObject({ tests: "2", failures: "1" });
  // The case has no bar of its own, so only the suite fails.
  expect(testNamed(root, "alpha")?.children.map((c) => c.name)).toEqual([
    SYSTEM_OUT,
  ]);
  const failure = testNamed(root, SUITE_SCORE)?.children[0];
  expect(failure?.name).toBe("failure");
  expect(failure?.attributes["message"]).toBe(
    "suite score 0.50 (1 of 1 runs) does not reach --min-score 0.90",
  );
  // Reached: the same testcase, no failure.
  fs.rmSync(path.join(box.root, RESULTS), { recursive: true });
  await box.cli(
    scoreArgs(box, RESULTS, "--min-score", "0.4", "--report", JUNIT),
  );
  const passed = parseXml(read(path.join(box.root, RESULTS), REPORT));
  expect(testNamed(passed, SUITE_SCORE)?.children.map((c) => c.name)).toEqual([
    SYSTEM_OUT,
  ]);
});

test("junit has an error testcase when the subject directory changed", () => {
  const changed = {
    ...hostileLike(),
    sourceChanged: ["kit/skills/x/SKILL.md"],
  };
  const root = parseXml(renderJunit(changed));
  const test = testNamed(root, "subject unchanged");
  expect(test?.children[0]?.name).toBe("error");
  expect(test?.children[0]?.attributes["message"]).toContain(
    "kit/skills/x/SKILL.md",
  );
});

test("junit files a case with tolerated invalid runs by its score, and one over the budget as an error", async () => {
  const box = sandbox();
  scriptedCase(box, "flaky", { before: CRASH_ONCE });
  const out = path.join(box.root, RESULTS);
  const tolerated = await box.cli(
    scoreArgs(
      box,
      RESULTS,
      "--reps",
      "2",
      "--max-invalid",
      "0.5",
      "--report",
      "junit,json",
    ),
  );
  expect(tolerated.status, tolerated.stderr).toBe(0);
  const flaky = testNamed(parseXml(read(out, REPORT)), "flaky");
  expect(flaky?.children.map((child) => child.name)).toEqual([
    SYSTEM_OUT,
    "system-err",
  ]);
  expect(flaky?.children[0]?.text).toBe("score 1.00 (1 of 2 runs)");
  expect(flaky?.children[1]?.text).toContain("rep 1: run failed");
  const report = JSON.parse(read(out, "report.json")) as JsonReport;
  expect(report.cases[0]).toMatchObject({ status: "invalid", tolerated: true });

  fs.rmSync(out, { recursive: true });
  // The script crashes on the first start of the sandbox only; start counting again.
  fs.rmSync(path.join(box.root, "fake/starts"), { recursive: true });
  const over = await box.cli(
    scoreArgs(
      box,
      RESULTS,
      "--reps",
      "2",
      "--max-invalid",
      "0.25",
      "--report",
      "junit,json",
    ),
  );
  expect(over.status, over.stderr).toBe(3);
  expect(
    testNamed(parseXml(read(out, REPORT)), "flaky")?.children[0]?.name,
  ).toBe("error");
  const again = JSON.parse(read(out, "report.json")) as JsonReport;
  expect(again.cases[0]).toMatchObject({ status: "invalid", tolerated: false });
});

test("junit puts a line break in an attribute as a reference, which a reader keeps", () => {
  const text = renderJunit(hostileLike());
  expect(text).not.toMatch(/message="[^"]*\n/);
  expect(text).toContain("&#10;");
  const root = parseXml(text);
  expect(testNamed(root, "subject unchanged")).toBeUndefined();
  const [, skipped] = root.children[0]?.children ?? [];
  expect(skipped?.children[0]?.attributes["message"]).toContain("\n");
});

/**
 * Makes an evaluation with a case whose reason has a line break.
 * @returns What the JUnit renderer reads.
 */
function hostileLike(): Evaluation {
  const runs = { subject: { valid: 0, planned: 1 } };
  return {
    schemaVersion: 1,
    exit: 3,
    minScore: null,
    maxInvalid: 0,
    sourceChanged: [],
    subjects: [{ label: "subject" }],
    barSubject: "subject",
    comparisons: [],
    suites: [
      {
        harness: "h",
        cases: [{ id: "c", weight: 1, scores: { subject: null }, runs }],
        suite: { subject: null },
        applicable: 1,
        total: 2,
        runs,
      },
    ],
    records: [],
    notRun: [],
    notApplicable: [
      {
        harness: "h",
        caseId: "skipped",
        missing: ["mcp"],
        reason: "first\nsecond",
      },
    ],
    belowBar: [],
    partial: null,
  } as unknown as Evaluation;
}
