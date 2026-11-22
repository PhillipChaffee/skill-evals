import { expect, test } from "vitest";
import { CONFIG_FILE } from "../project.js";
import { skillsFolder } from "../testing/plant.js";
import { sandbox } from "../testing/sandbox.js";

/**
 * Runs `validate` on one case.
 * @param checks - The case's checks.
 * @param config - What the config file holds, if anything.
 * @returns What validate printed.
 */
async function validated(checks: unknown[], config?: unknown): Promise<string> {
  const box = sandbox();
  box.write("cases/c/prompt.md", "say it\n");
  box.write("cases/c/case.json", { checks });
  if (config !== undefined) box.write(CONFIG_FILE, config);
  const subject = skillsFolder(box, "skills", { alpha: "# alpha\n" });
  const ran = await box.cli([
    "validate",
    "--subject",
    subject,
    "--cases",
    `${box.root}/cases`,
  ]);
  return ran.stdout;
}

const FILE = { type: "file_exists", path: "notes.txt" };

test("validate warns at 60% judged weight", async () => {
  const out = await validated([
    { type: "judge", rubric: "r", weight: 2 },
    { type: "decision", question: "q", expect: "yes" },
    { ...FILE, weight: 2 },
  ]);
  expect(out).toContain(
    "warning c: judge and decision checks carry 60% of the case's weight, above the limit of 50% (maxJudgedWeightShare)",
  );
});

test("validate is quiet at or below the share, and the share is configurable", async () => {
  const half = [{ type: "judge", rubric: "r" }, FILE];
  expect(await validated(half)).not.toContain("maxJudgedWeightShare");
  const mostly = [{ type: "judge", rubric: "r", weight: 3 }, FILE];
  expect(await validated(mostly, { maxJudgedWeightShare: 0.75 })).not.toContain(
    "maxJudgedWeightShare",
  );
  expect(await validated(mostly, { maxJudgedWeightShare: 0.7 })).toContain(
    "above the limit of 70%",
  );
});

test("a judged weight share outside 0 to 1 is a config error", async () => {
  const box = sandbox();
  box.write(CONFIG_FILE, { maxJudgedWeightShare: 1.5 });
  const ran = await box.cli(["list"]);
  expect(ran.stderr).toMatch(
    /"maxJudgedWeightShare" must be a number from 0 to 1/,
  );
});
