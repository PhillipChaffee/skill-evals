import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { plugin } from "./testing/plant.js";
import { sandbox } from "./testing/sandbox.js";
import { NEVER, WRITES_SUMMARY, compared } from "./testing/delta.js";

test("calibrate applies no pass bar: not --min-score, a case's minScore or minDelta, and no JUnit failure", async () => {
  const box = sandbox();
  // Half the checks fail, so the score is 0.5 and the delta 0: each bar below would be missed by a run.
  box.write("skill-evals.config.json", { minScore: 0.9 });
  const { ran, out, results } = await compared(box, {
    checks: [WRITES_SUMMARY, NEVER],
    a: plugin(box, "plugin-same", {}),
    command: "calibrate",
    reps: 2,
    more: { minScore: 0.9, minDelta: 0.1 },
    flags: ["--report", "md,junit"],
  });
  expect(ran.status, ran.stderr).toBe(0);
  expect(results?.belowBar).toEqual([]);
  expect(results?.minScore).toBeNull();
  expect(results?.minDelta).toBeNull();
  const xml = fs.readFileSync(path.join(out, "report.xml"), "utf8");
  expect(xml).not.toContain("<failure");
  expect(ran.stdout).not.toContain("Below the pass bar");
});

test("the same bars do fail a run", async () => {
  const box = sandbox();
  const { ran } = await compared(box, {
    checks: [WRITES_SUMMARY, NEVER],
    a: plugin(box, "plugin-same", {}),
    b: plugin(box, "plugin-other", {}),
    reps: 2,
    more: { minScore: 0.9 },
  });
  expect(ran.status).toBe(1);
});
