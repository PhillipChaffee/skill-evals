import { expect, test } from "vitest";
import { HARNESSES } from "./harnesses/index.js";
import type { Harness } from "./harnesses/shared.js";
import { noteSections } from "./report-notes.js";
import { session } from "./session.js";
import { judgeAsker } from "./startup.js";
import { scored, slowRun } from "./testing/limits.js";
import { fixture, sandbox } from "./testing/sandbox.js";

// A timeout takes the case's timeout plus a drain; vitest's 5 s default is too tight under load.
const TEST_TIMEOUT_MS = 30_000;
const CLAUDE = HARNESSES.find(
  (harness) => harness.id === "claude-code",
) as Harness;

/**
 * Runs a callback with environment variables set, and restores them.
 * @param vars - The variables.
 * @param use - What to run.
 * @returns What it returns.
 */
async function withEnv<T>(
  vars: Record<string, string>,
  use: () => Promise<T>,
): Promise<T> {
  const before = Object.fromEntries(
    Object.keys(vars).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, vars);
  try {
    return await use();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  }
}

test(
  "a stop request that arrives in the drain after a timeout does not turn the timeout into a maxTurns stop",
  async () => {
    const box = sandbox();
    // A helper outside the process group writes two more turns about when the one-second timeout has fired.
    const { record } = await slowRun(box, {
      turns: 1,
      caseFile: { maxTurns: 1, timeoutSeconds: 1 },
      late: true,
    });

    expect(record).toMatchObject({
      ok: false,
      score: null,
      stoppedBy: "timeout",
      error: "timed out after 1 s",
    });
  },
  TEST_TIMEOUT_MS,
);

test(
  'onTimeout "score" on a run that wrote nothing is invalid, and says so',
  async () => {
    const box = sandbox();
    const { record } = await slowRun(box, {
      turns: 0,
      caseFile: {
        timeoutSeconds: 2,
        onTimeout: "score",
      },
    });

    expect(record).toMatchObject({
      ok: false,
      score: null,
      stoppedBy: "timeout",
      error: "timed out after 2 s before the agent did anything",
    });
  },
  TEST_TIMEOUT_MS,
);

test(
  "a judge that the runner stopped at maxTurns is a failed attempt",
  async () => {
    const box = sandbox();
    box.write("fake/none", "");
    const ask = judgeAsker(
      { harness: CLAUDE, bin: fixture("slow-harness.mjs") },
      { isolated: false, withhold: [], pass: ["SLOW_TURNS"] },
      [],
    );
    const reply = await withEnv({ SLOW_TURNS: "5" }, () => ask("grade this"));

    expect(reply.error).toBe("the judge was stopped at maxTurns");
  },
  TEST_TIMEOUT_MS,
);

test(
  "a turn counter that throws fails the run with a message, and the run is stopped",
  async () => {
    const counting: Harness = {
      ...CLAUDE,
      countTurns: () => {
        throw new Error("boom");
      },
    };
    const ran = await withEnv({ SLOW_TURNS: "3" }, () =>
      session(
        {
          harness: counting,
          bin: fixture("slow-harness.mjs"),
          subject: null,
          prompt: "x",
          maxTurns: 1,
          timeoutSeconds: 20,
          pass: ["SLOW_TURNS"],
        },
        (result) => result,
      ),
    );

    expect(ran).toMatchObject({
      error: "the turn counter failed: boom",
      stoppedBy: "agent",
    });
  },
  TEST_TIMEOUT_MS,
);

test(
  "the report counts the runs that the runner ended, and the progress line says so",
  async () => {
    const box = sandbox();
    const { result } = await slowRun(box, {
      turns: 5,
      caseFile: {
        maxTurns: 2,
        timeoutSeconds: 20,
      },
    });

    expect(result.stdout).toContain("## Stopped by the runner");
    expect(result.stdout).toContain(
      "- claude-code `hello`: 1 of 1 runs stopped at maxTurns",
    );
    expect(result.stderr).toMatch(
      /^claude-code hello subject1: score 1\.00 \(stopped at maxTurns\) \[1\/1\] /m,
    );

    const scoredTimeout = await slowRun(sandbox(), {
      turns: 1,
      caseFile: {
        timeoutSeconds: 5,
        onTimeout: "score",
      },
    });
    expect(scoredTimeout.result.stdout).toContain(
      "- claude-code `hello`: 1 of 1 runs timed out and were scored (onTimeout: score)",
    );
    expect(scoredTimeout.result.stderr).toMatch(
      /\(timed out, scored\) \[1\/1\] /m,
    );
  },
  TEST_TIMEOUT_MS,
);

test("a report with no stopped run has no such section", async () => {
  const { result } = await scored(sandbox());
  expect(result.stdout).not.toContain("Stopped by the runner");
});

test("the report counts a timed-out run as scored only when it has no invalid reason at all", () => {
  const record = (more: Record<string, unknown>) =>
    ({
      harness: "claude-code",
      caseId: "c",
      stoppedBy: "timeout",
      error: null,
      subjectLoaded: true,
      isolated: false,
      reportMissing: false,
      unexpected: [],
      judgeProblem: null,
      checks: [],
      ...more,
    }) as never;
  const evaluation = {
    records: [record({}), record({ subjectLoaded: false })],
    cases: [],
    skippedChecks: [],
    notApplicable: [],
    partial: null,
  } as never;

  expect(noteSections(evaluation).join("\n")).toContain(
    "- claude-code `c`: 1 of 2 runs timed out and were scored (onTimeout: score)",
  );
});
