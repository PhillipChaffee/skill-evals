import fs from "node:fs";
import { expect, test } from "vitest";
import { gone, scored, slowRun } from "./testing/limits.js";
import { script } from "./testing/plant.js";
import { fixture, sandbox } from "./testing/sandbox.js";

// A stop and a timeout both take the case's timeout plus a drain; vitest's 5 s default is too tight under load.
const TEST_TIMEOUT_MS = 30_000;
const HEARTBEAT_WAIT_MS = 300;
const STOP_WITHIN_MS = 5000;
// Long enough for a loaded machine to start the harness and write its turns before the time limit.
const SAFE_TIMEOUT_SECONDS = 5;
const POLL_MS = 50;
const POLL_TRIES = 60;

test(
  "a run stopped at maxTurns is scored and says so",
  async () => {
    const box = sandbox();
    const { result, record } = await slowRun(box, {
      turns: 5,
      caseFile: {
        maxTurns: 2,
        timeoutSeconds: 20,
      },
    });

    expect(result.status).toBe(0);
    expect(record).toMatchObject({
      ok: true,
      error: null,
      score: 1,
      stoppedBy: "maxTurns",
      maxTurnsEnforced: true,
    });
    // The runner stops as turn 3 begins, so that partial turn is in the transcript and the final text. Turns that
    // arrive in the same chunk are kept too, so a loaded machine may show more.
    expect(record?.turns).toBeGreaterThanOrEqual(3);
    expect(record?.finalText).toBe(`turn ${String(record?.turns)}`);
    expect(record?.firstOutputMs).toBeGreaterThanOrEqual(0);
    // The harness writes its totals only at the end, so a stopped run has none.
    expect(record).toMatchObject({ tokens: null, costUsd: null });
  },
  TEST_TIMEOUT_MS,
);

test(
  "the process group is gone after a stop",
  async () => {
    const box = sandbox();
    const { files, record } = await slowRun(box, {
      turns: 3,
      caseFile: {
        maxTurns: 1,
        timeoutSeconds: 20,
      },
    });

    // The stop, not the 20 s timeout or the reap on exit, ended the run: it was quick, and it says maxTurns.
    expect(record?.stoppedBy).toBe("maxTurns");
    expect(record?.durationMs).toBeLessThan(STOP_WITHIN_MS);

    const pid = Number(fs.readFileSync(files.pid, "utf8"));
    for (let tries = 0; tries < POLL_TRIES && !gone(pid); tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    expect(gone(pid)).toBe(true);
    const beats = fs.readFileSync(files.heartbeat, "utf8");
    await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_WAIT_MS));
    expect(fs.readFileSync(files.heartbeat, "utf8")).toBe(beats);
  },
  TEST_TIMEOUT_MS,
);

test(
  "a timeout stays invalid with stoppedBy timeout",
  async () => {
    const box = sandbox();
    const { result, record } = await slowRun(box, {
      turns: 1,
      caseFile: {
        timeoutSeconds: SAFE_TIMEOUT_SECONDS,
      },
    });

    expect(result.status).toBe(1);
    expect(record).toMatchObject({
      ok: false,
      error: `timed out after ${String(SAFE_TIMEOUT_SECONDS)} s`,
      score: null,
      stoppedBy: "timeout",
      maxTurnsEnforced: null,
    });
    expect(record?.firstOutputMs).toBeGreaterThanOrEqual(0);
  },
  TEST_TIMEOUT_MS,
);

test(
  "a timeout with no output at all has a null firstOutputMs",
  async () => {
    const box = sandbox();
    const { record } = await slowRun(box, {
      turns: 0,
      caseFile: { timeoutSeconds: 2 },
    });

    expect(record).toMatchObject({ stoppedBy: "timeout", firstOutputMs: null });
  },
  TEST_TIMEOUT_MS,
);

test(
  'onTimeout "score" scores a timed-out run on what it left',
  async () => {
    const box = sandbox();
    const { result, record } = await slowRun(box, {
      turns: 2,
      caseFile: {
        timeoutSeconds: SAFE_TIMEOUT_SECONDS,
        onTimeout: "score",
      },
    });

    expect(result.status).toBe(0);
    // The stream has no result event, which the parse would call an error; a run that was cut is not held to that.
    expect(record).toMatchObject({
      ok: true,
      error: null,
      score: 1,
      stoppedBy: "timeout",
      finalText: "turn 2",
      turns: 2,
    });
  },
  TEST_TIMEOUT_MS,
);

test("Claude Code's own turn limit is a stop that is scored, not a failed run", async () => {
  const box = sandbox();
  script(box, "limit", {
    turns: [[{ text: "got this far" }, { limit: true }]],
  });
  const { result, record } = await scored(box, { caseFile: { maxTurns: 5 } });

  // The fake exits with code 1 and an `is_error` result, as the CLI does; neither fails the run.
  expect(result.status).toBe(0);
  expect(record).toMatchObject({
    ok: true,
    error: null,
    score: 1,
    stoppedBy: "maxTurns",
    maxTurnsEnforced: true,
    turns: 1,
    finalText: "got this far",
  });
});

test("subagent turns do not count toward maxTurns", async () => {
  const box = sandbox();
  const child = ["a", "b", "c", "d"].map((text) => ({ text }));
  script(box, "agents", {
    turns: [
      [
        { agent: { type: "helper", prompt: "go", steps: child } },
        { final: "done" },
      ],
    ],
  });
  const { record } = await scored(box, { caseFile: { maxTurns: 2 } });

  // One main turn dispatches and the result closes the run; the four turns of the child are not counted.
  expect(record).toMatchObject({
    ok: true,
    stoppedBy: "agent",
    maxTurnsEnforced: true,
    turns: 1,
    finalText: "done",
  });
});

test("every record has firstOutputMs, turns and stoppedBy, and maxTurnsEnforced is null without a limit", async () => {
  const box = sandbox();
  script(box, "plain", { turns: [[{ text: "one" }, { text: "two" }]] });
  const { record } = await scored(box);

  expect(record).toMatchObject({
    stoppedBy: "agent",
    maxTurnsEnforced: null,
    turns: 2,
  });
  expect(record?.firstOutputMs).toBeGreaterThanOrEqual(0);
});

test("a harness that cannot start is stoppedBy agent", async () => {
  const box = sandbox();
  const broken = box.write("broken-harness", "#!/no/such/interpreter\n");
  fs.chmodSync(broken, 0o755);
  const { record } = await scored(box, {
    env: { SKILL_EVALS_BIN_CLAUDE_CODE: broken },
  });

  expect(record).toMatchObject({
    ok: false,
    stoppedBy: "agent",
    firstOutputMs: null,
  });
});

test("a harness without turn counting records maxTurnsEnforced false and a report note", async () => {
  const box = sandbox();
  const cursor = box.write(
    "bin/fake-cursor.mjs",
    `#!/usr/bin/env node\nimport fs from "node:fs";\nprocess.stdout.write(fs.readFileSync(${JSON.stringify(fixture("cursor.stream.jsonl"))}));\n`,
  );
  fs.chmodSync(cursor, 0o755);
  const { result, record } = await scored(box, {
    env: { SKILL_EVALS_BIN_CURSOR: cursor },
    caseFile: { maxTurns: 3 },
    flags: ["--harness", "cursor"],
  });

  expect(record).toMatchObject({
    harness: "cursor",
    ok: true,
    stoppedBy: "agent",
    maxTurnsEnforced: false,
    turns: null,
  });
  expect(result.stdout).toContain("## Limits not enforced");
  expect(result.stdout).toContain(
    "- cursor `hello`: maxTurns 3 is not enforced: the harness cannot count turns (no turnGrouping)",
  );
});

test("a report has no limits section when every limit was enforced", async () => {
  const box = sandbox();
  script(box, "plain", { turns: [[{ text: "one" }]] });
  const { result } = await scored(box, { caseFile: { maxTurns: 3 } });

  expect(result.stdout).not.toContain("Limits not enforced");
});
