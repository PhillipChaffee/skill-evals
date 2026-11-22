import fs from "node:fs";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { loadCases } from "./cases.js";
import { main } from "./cli.js";
import { evaluate } from "./evaluate.js";
import { asProcess, sandbox } from "./testing/sandbox.js";

/**
 * Plants one skills folder and one case that it half passes.
 * @returns The sandbox, and an `evaluate` that finds the harness through the environment, as the CLI does.
 */
function planted() {
  const box = sandbox();
  box.write("mine/greet/SKILL.md", "Say hello.\n");
  box.write("evals/cases/hello/prompt.md", "use greet to say hello\n");
  box.write("evals/cases/hello/case.json", {
    checks: [
      { type: "skill_loaded", skill: "greet" },
      { type: "output_contains", text: "no such text" },
    ],
  });
  const run = (options: Omit<Parameters<typeof evaluate>[0], "cwd">) =>
    asProcess({ env: box.env, cwd: "/" }, () =>
      evaluate({ cwd: box.root, ...options }),
    );
  return { box, run };
}

test("evaluate returns suite scores for one subject without printing or exiting", async () => {
  const { box, run } = planted();
  const seen: string[] = [];
  const ran = await run({
    subjects: ["mine"],
    reps: 2,
    minScore: 0.9,
    outDir: "results",
    onRun: (record) => seen.push(`${record.subject}${String(record.rep)}`),
  });

  const evaluation = ran.value;
  expect(evaluation.suites).toStrictEqual([
    {
      harness: "claude-code",
      cases: [
        {
          id: "hello",
          weight: 1,
          minScore: undefined,
          scores: { subject: 0.5 },
          runs: { subject: { valid: 2, planned: 2 } },
        },
      ],
      suite: { subject: 0.5 },
      applicable: 1,
      total: 1,
      runs: { subject: { valid: 2, planned: 2 } },
    },
  ]);
  expect(evaluation.records.map((record) => record.score)).toEqual([0.5, 0.5]);
  expect(evaluation.belowBar).toEqual([
    "claude-code: suite score 0.50 (2 of 2 runs) does not reach --min-score 0.90",
  ]);
  expect(evaluation.invalid).toEqual([]);
  expect(evaluation.outDir).toBe(path.join(box.root, "results"));
  expect(evaluation.cases.map((caseDef) => caseDef.id)).toEqual(["hello"]);
  const written = path.join(evaluation.outDir, "results.json");
  expect(fs.readFileSync(written, "utf8")).toBe(
    JSON.stringify(
      {
        ...evaluation,
        exit: undefined,
        cases: undefined,
        applied: undefined,
        outDir: undefined,
      },
      null,
      "\t",
    ),
  );
  expect(seen).toEqual(["subject1", "subject2"]);
  expect([ran.stdout, ran.stderr]).toEqual(["", ""]);
});

test("evaluate rejects a wrong option with a UsageError", async () => {
  const { box, run } = planted();
  const usageError = { name: "UsageError" };
  await expect(run({ subjects: [] })).rejects.toMatchObject(usageError);
  await expect(run({ subjects: ["a", "b", "c"] })).rejects.toMatchObject(
    usageError,
  );
  await expect(run({ subjects: ["mine"], reps: 0 })).rejects.toMatchObject(
    usageError,
  );
  await expect(run({ subjects: ["mine"], minScore: 2 })).rejects.toMatchObject({
    message: "minScore must be a number from 0 to 1",
  });
  expect(
    loadCases(path.join(box.root, "evals/cases")).map((caseDef) => caseDef.id),
  ).toEqual(["hello"]);
});

test("evaluate lists the runs that do not count, each with its reason", async () => {
  const { box, run } = planted();
  box.write("fake/hide-skills", "");
  const { value } = await run({
    subjects: ["mine"],
    reps: 1,
    outDir: "results",
  });
  expect(value.invalid).toEqual([
    "claude-code hello subject1: the harness did not load the subject: it is not among the plugins and skills it reported",
  ]);
  expect(value.suites[0]?.suite).toEqual({ subject: null });
});

test("on win32 the CLI exits 2 with one line", async () => {
  const platform = vi
    .spyOn(process, "platform", "get")
    .mockReturnValue("win32");
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    expect(await main(["list"])).toBe(2);
    expect(error.mock.calls).toEqual([
      ["skill-evals: Windows is not supported; use macOS, Linux, or WSL"],
    ]);
  } finally {
    platform.mockRestore();
    error.mockRestore();
  }
});
