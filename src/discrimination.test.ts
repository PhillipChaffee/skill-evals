import fs from "node:fs";
import { expect, test } from "vitest";
import type { Discrimination } from "./comparison.js";
import { plugin } from "./testing/plant.js";
import { sandbox } from "./testing/sandbox.js";
import {
  LOADS_BRO,
  NEVER,
  WRITES_SUMMARY,
  compared,
  readJson,
} from "./testing/delta.js";

const REPORT_JSON = "report.json";
// Each case says which label it should get, and why that label is the first that fits.
const CASES: Record<
  string,
  { checks: unknown[]; guard?: boolean; label: Discrimination | null }
> = {
  // The none arm scores 1.00.
  easy: { checks: [WRITES_SUMMARY], label: "non-discriminating" },
  // The none arm scores 1.00 and the subject 0.00: it fits the first and the second label, and the first wins.
  regress: {
    checks: [{ type: "skill_not_loaded", skill: "bro" }],
    label: "non-discriminating",
  },
  // None 0.00 and subject 0.00.
  broken: { checks: [NEVER], label: "failing with the subject" },
  // None 0.00, subject 0.40, and the subject helped: it fits the second and the third, and the second wins.
  partial: {
    checks: [
      { ...LOADS_BRO, weight: 2 },
      { ...NEVER, weight: 3 },
    ],
    label: "failing with the subject",
  },
  // None 0.00, subject 1.00.
  helped: { checks: [LOADS_BRO], label: "discriminating" },
  // Both arms 0.50.
  same: { checks: [WRITES_SUMMARY, NEVER], label: "no evidence" },
  // A guard case would be discriminating, and is left out.
  guarded: { checks: [LOADS_BRO], guard: true, label: null },
};

/**
 * Plants the cases above and compares `none` with a plugin whose agent loads `bro`.
 * @param flip - Puts the subject first and `none` second.
 * @returns The command's result and output directory.
 */
async function discriminated(flip = false) {
  const box = sandbox();
  for (const [id, { checks, guard }] of Object.entries(CASES)) {
    box.write(`cases/${id}/prompt.md`, `do ${id}\n`);
    box.write(`cases/${id}/case.json`, { checks, ...(guard ? { guard } : {}) });
  }
  const loader = plugin(box, "plugin-loader", { skill: "bro" });
  const ran = await box.cli([
    "run",
    ...(flip ? ["--a", loader, "--b", "none"] : ["--a", "none", "--b", loader]),
    ...[
      "--cases",
      `${box.root}/cases`,
      "--reps",
      "2",
      "--out",
      `${box.root}/results`,
    ],
    ...["--report", "md,json,html"],
  ]);
  return { ran, out: `${box.root}/results` };
}

type Report = {
  cases: { subject: string; caseId: string; discrimination: string | null }[];
  method: { discrimination: unknown };
};

test("each case gets the first label that fits, in the order of the rule", async () => {
  const { ran, out } = await discriminated();
  expect(ran.status, ran.stderr).toBe(0);
  const report = readJson(out, REPORT_JSON) as Report;
  const labels = Object.fromEntries(
    report.cases
      .filter((one) => one.subject === "b")
      .map((one) => [one.caseId, one.discrimination]),
  );
  expect(labels).toEqual(
    Object.fromEntries(
      Object.entries(CASES).map(([id, { label }]) => [id, label]),
    ),
  );
});

test("the report prints both thresholds, and the label does not depend on which subject is none", async () => {
  const { ran, out } = await discriminated();
  expect(ran.stdout).toContain(
    "non-discriminating when the none arm scores at least 0.9 (NON_DISCRIMINATING_FLOOR)",
  );
  expect(ran.stdout).toContain(
    "failing with the subject when the subject scores below 0.5 (FAILING_CEILING)",
  );
  const report = readJson(out, REPORT_JSON) as Report;
  expect(report.method.discrimination).toEqual({
    nonDiscriminatingFloor: 0.9,
    failingCeiling: 0.5,
  });
  const flipped = await discriminated(true);
  const [first, second] = [out, flipped.out].map((dir) =>
    (readJson(dir, REPORT_JSON) as Report).cases
      .filter((one) => one.subject === "b")
      .map((one) => `${one.caseId} ${String(one.discrimination)}`),
  );
  expect(second).toEqual(first);
});

test("guard cases are left out of the discrimination table", async () => {
  const { ran, out } = await discriminated();
  const section = ran.stdout.split("### Discrimination")[1] ?? "";
  const rows = section.split("\n").filter((line) => line.startsWith("| "));
  const listed = rows.slice(2).map((line) => line.split(" | ")[0]?.slice(2));
  expect(listed.sort()).toEqual([
    "broken",
    "easy",
    "helped",
    "partial",
    "regress",
    "same",
  ]);
  expect(section).toContain("Guard cases are left out");
  expect(section).not.toContain("guarded");
  const report = readJson(out, REPORT_JSON) as Report;
  const guard = report.cases.filter((one) => one.caseId === "guarded");
  expect(guard.map((one) => one.discrimination)).toEqual([null, null]);
  const html = fs.readFileSync(`${out}/report.html`, "utf8");
  const table =
    html.split("<h2>Discrimination</h2>")[1]?.split("<h2>")[0] ?? "";
  expect(table).toContain("<td>helped</td>");
  expect(table).not.toContain("guarded");
});

test("there is no discrimination when neither subject is none, or both are", async () => {
  const box = sandbox();
  const plain = await compared(box, { checks: [WRITES_SUMMARY] });
  expect(plain.ran.stdout).not.toContain("Discrimination");
  const same = await compared(box, {
    checks: [WRITES_SUMMARY],
    a: "none",
    b: "none",
  });
  expect(same.ran.stdout).not.toContain("### Discrimination");
});
