import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { scoreArgs, scriptedCase } from "./testing/budget.js";
import { readResults, sandbox, tableRow } from "./testing/sandbox.js";

// The fake counts its starts in a file, so a step that is played on some starts alternates between runs.
const writesOn = (starts: number[]) => ({
  onStart: starts,
  step: {
    call: {
      name: "Write",
      input: {},
      write: { path: "out/flaky.txt", content: "x" },
    },
  },
});
const FLAKY = { type: "file_exists", path: "out/flaky.txt" };

test("a flaky check shows its rate", async () => {
  const box = sandbox();
  // Starts 1 and 3 write the file; start 2 does not: the check passes, fails, passes.
  scriptedCase(box, "solo", { before: [writesOn([1, 3])], checks: [FLAKY] });
  const ran = await box.cli(
    scoreArgs(box, "results", "--reps", "3", "--report", "md,html"),
  );
  expect(ran.status, ran.stderr).toBe(0);
  const row = tableRow(ran.stdout, "solo");
  // The summary check never flips; the one reps disagree on is the minority 1 of 3.
  expect(row).toContain("| 0%<br>33% |");
  expect(row).toContain("`file_exists out/flaky.txt` 2/3");
  const html = fs.readFileSync(
    path.join(box.root, "results", "report.html"),
    "utf8",
  );
  expect(html).toContain("<h2>Flake</h2>");
  expect(html).toContain("<td>33%</td>");
  expect(html).toContain("at a score of 0.5 or more");
  expect(readResults(path.join(box.root, "results")).records).toHaveLength(3);
});

test("an even split is 50%, a check that agrees is 0%, and a comparison gives a rate for each subject", async () => {
  const box = sandbox();
  scriptedCase(box, "solo", { before: [writesOn([1])], checks: [FLAKY] });
  const split = await box.cli(scoreArgs(box, "results", "--reps", "2"));
  expect(tableRow(split.stdout, "solo")).toContain("| 0%<br>50% |");

  // Six starts, in the order a1 b1 a2 b2 a3 b3: A writes on starts 1 and 3 (a1, a2) and B never does.
  const both = sandbox();
  scriptedCase(both, "solo", { before: [writesOn([1, 3])], checks: [FLAKY] });
  const compared = await both.cli([
    ...["run", "--a", "none", "--b", "none"],
    ...["--cases", path.join(both.root, "suite"), "--reps", "3"],
    ...["--out", path.join(both.root, "results")],
  ]);
  expect(tableRow(compared.stdout, "solo")).toContain(
    "| A 0%, B 0%<br>A 33%, B 0% |",
  );
});

test("a check with no valid run has no flake rate, and a rep passes at a score of 0.5", async () => {
  const box = sandbox();
  scriptedCase(box, "solo", {
    before: [{ fail: "boom" }],
    checks: [FLAKY],
  });
  const ran = await box.cli(scoreArgs(box, "results", "--reps", "2"));
  expect(tableRow(ran.stdout, "solo")).toContain("| n/a<br>n/a |");
});
