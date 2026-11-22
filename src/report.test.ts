import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { priced, scoreArgs, scriptedCase } from "./testing/budget.js";
import { readResults, sandbox } from "./testing/sandbox.js";
import type { Sandbox } from "./testing/sandbox.js";
import { parseXml, testNamed } from "./testing/xml.js";
import type { XmlElement } from "./testing/xml.js";
import type { JsonReport } from "./report/json.js";
import type { Summary } from "./summary.js";

const RESULTS = "results";
const NEVER = { type: "output_contains", text: "never said" };
const CRASH_ONCE = [{ onStart: [1], step: { crash: "segfault" } }];
const ALL = ["--report", "md,json,junit,html"];

/**
 * Plants one case of each kind: one that passes, one under its bar, one with an invalid run, and one that needs a
 * capability the harness lacks.
 * @param box - The sandbox.
 */
function plantKinds(box: Sandbox): void {
  scriptedCase(box, "fine");
  scriptedCase(box, "weak", { checks: [NEVER], more: { minScore: 0.9 } });
  scriptedCase(box, "broken", { before: CRASH_ONCE });
  box.write("suite/needs-mcp/prompt.md", "do needs-mcp\n");
  box.write("suite/needs-mcp/case.json", {
    requires: ["mcp"],
    checks: [NEVER],
  });
}

/**
 * Scores the planted kinds and reads what was written.
 * @param extra - More arguments of the command.
 * @returns The command's result and the output directory.
 */
async function scoredKinds(...extra: string[]) {
  const box = sandbox();
  plantKinds(box);
  const out = path.join(box.root, RESULTS);
  const ran = await box.cli(
    scoreArgs(box, RESULTS, "--max-invalid", "1", ...ALL, ...extra),
  );
  return { box, ran, out };
}

const read = (out: string, file: string): string =>
  fs.readFileSync(path.join(out, file), "utf8");
test("junit marks a not-applicable case skipped", async () => {
  const { ran, out } = await scoredKinds();
  // `broken` has no valid run, so --max-invalid 1 does not excuse it.
  expect(ran.status, ran.stderr).toBe(3);
  const root = parseXml(read(out, "report.xml"));
  expect(root.name).toBe("testsuites");
  expect(root.children).toHaveLength(1);
  const suite = root.children[0] as XmlElement;
  expect(suite.attributes).toMatchObject({
    name: "claude-code subject",
    tests: "5",
    failures: "1",
    errors: "1",
    skipped: "1",
  });
  const kind = (name: string): string[] =>
    (testNamed(root, name)?.children ?? []).map((child) => child.name);
  expect(kind("fine")).toEqual(["system-out"]);
  expect(kind("weak")).toEqual(["failure", "system-out"]);
  expect(kind("broken")).toEqual(["error"]);
  expect(kind("needs-mcp")).toEqual(["skipped"]);
  const skipped = testNamed(root, "needs-mcp")?.children[0];
  expect(skipped?.attributes["message"]).toContain("mcp");
  expect(testNamed(root, "weak")?.children[0]?.attributes["message"]).toContain(
    "0.9",
  );
  expect(
    testNamed(root, "broken")?.children[0]?.attributes["message"],
  ).toContain("run failed");
});

test("junit marks a run that did not run as skipped with the message not run", async () => {
  const box = sandbox();
  priced(box, ["alpha", "bravo", "charlie"], 0.4);
  const ran = await box.cli(
    scoreArgs(box, RESULTS, "--max-cost", "0.5", "--report", "junit"),
  );
  expect(ran.status, ran.stderr).toBe(4);
  const root = parseXml(read(path.join(box.root, RESULTS), "report.xml"));
  const charlie = testNamed(root, "charlie");
  expect(charlie?.children[0]?.name).toBe("skipped");
  expect(charlie?.children[0]?.attributes["message"]).toBe("not run");
});

test("summary.json matches the report's suite score", async () => {
  const { ran, out } = await scoredKinds();
  const summary = JSON.parse(read(out, "summary.json")) as Summary;
  const report = JSON.parse(read(out, "report.json")) as JsonReport;
  const results = readResults(out);
  expect(report.schemaVersion).toBe(1);
  expect(report.summary).toEqual(summary);
  expect(summary).toMatchObject({
    schemaVersion: 1,
    exit: 3,
    invalid: 1,
    notApplicable: 1,
    partial: null,
  });
  expect(summary.suites).toEqual([
    {
      harness: "claude-code",
      label: "subject",
      score: results.suites[0]?.suite["subject"],
      applicable: 3,
      total: 4,
      validRuns: 2,
      plannedRuns: 3,
    },
  ]);
  expect(summary.belowBar).toEqual(results.belowBar);
  expect(summary.durationMs).toBeGreaterThanOrEqual(0);
  // A case with no valid run has no score, so the suite has none either.
  expect(summary.suites[0]?.score).toBeNull();
  expect(ran.stdout).toContain("Suite score: n/a (3 of 4 cases, 2 of 3 runs)");
  expect(report.cases.map((one) => [one.caseId, one.status])).toEqual([
    ["broken", "invalid"],
    ["fine", "pass"],
    ["weak", "below"],
    ["needs-mcp", "not-applicable"],
  ]);
  expect(report.cases[0]).toMatchObject({
    score: null,
    validRuns: 0,
    plannedRuns: 1,
  });
});

test("the valid-run count is beside every score", async () => {
  const box = sandbox();
  for (const id of ["fine", "weak"]) {
    scriptedCase(box, id, id === "weak" ? { checks: [NEVER] } : {});
  }
  const ran = await box.cli(
    scoreArgs(box, RESULTS, "--min-score", "0.99", "--report", "md,html,json"),
  );
  const counted = /\d\.\d\d(?: \(\+?-?\d\.\d\d\))? \(\d+ of \d+ runs\)/;
  const lines = ran.stdout.split("\n");
  const suite = lines.filter((line) => line.startsWith("Suite score:"));
  expect(suite).toHaveLength(1);
  expect(suite[0]).toMatch(
    /^Suite score: \d\.\d\d \(\d+ of \d+ cases, \d+ of \d+ runs\)$/,
  );
  const rows = lines.filter((line) => /^\| (fine|weak) \|/.test(line));
  expect(rows).toHaveLength(2);
  for (const row of rows) expect(row.split(" | ")[1]).toMatch(counted);
  const bars = lines.filter((line) => line.startsWith("- claude-code: "));
  expect(bars.length).toBeGreaterThan(0);
  for (const bar of bars)
    expect(bar).toMatch(/score \d\.\d\d \(\d+ of \d+ runs\)/);
  const html = read(path.join(box.root, RESULTS), "report.html");
  expect(html).toContain("<td>0.50</td><td>1 of 1 runs</td>");
});

test("html has no external reference", async () => {
  const { out } = await scoredKinds();
  const html = read(out, "report.html");
  expect(html).not.toMatch(/(src|href)="https?:/);
  expect(html).not.toContain("<script");
  expect(html).not.toMatch(/https?:\/\//);
  // Nothing else can fetch either: a stylesheet import, a url(), a protocol-relative address.
  expect(html).not.toMatch(/url\(|@import|\/\//);
  expect(html.match(/<html/g)).toHaveLength(1);
  expect(html).toContain("<table>");
});

test("the common set counts the planned runs, not only the finished ones", async () => {
  const box = sandbox();
  priced(box, ["alpha"], 0.4);
  const ran = await box.cli(
    scoreArgs(
      box,
      RESULTS,
      "--reps",
      "3",
      "--max-cost",
      "0.5",
      "--harness",
      "claude-code,pi",
    ),
    { SKILL_EVALS_BIN_PI: box.pi },
  );
  expect(ran.status, ran.stderr).toBe(4);
  const { commonSet } = readResults(path.join(box.root, RESULTS));
  // Two of the three planned runs finished before the budget stopped the command.
  expect(commonSet?.runs["claude-code"]?.["subject"]).toEqual({
    valid: 2,
    planned: 3,
  });
  expect(commonSet?.runs["pi"]?.["subject"]).toEqual({ valid: 0, planned: 3 });
  expect(ran.stdout).toContain("- claude-code: 1.00 (2 of 3 runs)");
});
