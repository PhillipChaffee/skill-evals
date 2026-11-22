import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { exec, killRunning } from "./exec.js";
import { onDispose, onInterrupt } from "./scope.js";
import { resumeArgs, scoreArgs, scriptedCase } from "./testing/budget.js";
import { fixture, readResults, sandbox } from "./testing/sandbox.js";
import { linesIn, startsOf } from "./testing/suite.js";

const INTERRUPTED = 130;
const TEST_TIMEOUT_MS = 60_000;
const POLL_MS = 25;
const WAIT_MS = 30_000;

/**
 * Waits for a condition.
 * @param ready - Tells whether it holds.
 * @param what - What is waited for, for the failure.
 */
async function until(ready: () => boolean, what: string): Promise<void> {
  const end = Date.now() + WAIT_MS;
  while (!ready()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/**
 * Tells whether bravo has started and counted its start, which it does just before it hangs.
 * @param box - The sandbox.
 * @returns True once the first start of bravo is on record.
 */
const hanging = (box: ReturnType<typeof sandbox>): boolean =>
  fs.existsSync(path.join(box.root, "fake/starts/case-bravo.json"));

/**
 * Plants three cases of which the second hangs on its first start.
 * @param box - The sandbox.
 */
function plant(box: ReturnType<typeof sandbox>): void {
  scriptedCase(box, "alpha");
  scriptedCase(box, "bravo", {
    before: [{ onStart: [1], step: { hang: true } }],
  });
  scriptedCase(box, "charlie");
}

test(
  "SIGINT writes the partial results, releases the lock, exits 130, and a resume completes the suite",
  async () => {
    const box = sandbox();
    plant(box);
    const out = path.join(box.root, "results");
    const child = spawn(
      process.execPath,
      [
        ...["--import", fixture("ts-register.mjs")],
        path.resolve(import.meta.dirname, "bin.ts"),
        ...scoreArgs(box, "results", "--jobs", "1"),
      ],
      { cwd: box.root, env: box.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    // Alpha is finished and bravo is in flight, hanging.
    await until(
      () =>
        fs.existsSync(path.join(out, "results.jsonl")) &&
        linesIn(out).length === 1 &&
        hanging(box),
      "the first run to finish and the second to start",
    );
    child.kill("SIGINT");
    const [code, signal] = (await once(child, "exit")) as [
      number | null,
      string | null,
    ];
    expect({ code, signal }, stderr).toEqual({
      code: INTERRUPTED,
      signal: null,
    });

    const results = readResults(out);
    expect(results.partial).toEqual({ reason: "interrupted" });
    expect(results.records.map((record) => record.caseId)).toEqual(["alpha"]);
    expect(linesIn(out)).toHaveLength(1);
    expect(fs.existsSync(path.join(out, ".lock")), "the lock is released").toBe(
      false,
    );
    expect(stderr).toContain(
      `interrupted after 1 of 3 runs; continue with --resume ${out}`,
    );

    // The resume does not repeat alpha; bravo, killed in flight, runs again, and so does charlie.
    const resumed = await box.cli(resumeArgs(box, "results"));
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(startsOf(box)).toBe(4);
    expect(readResults(out).records.map((record) => record.score)).toEqual([
      1, 1, 1,
    ]);
    expect(readResults(out).partial).toBeNull();
  },
  TEST_TIMEOUT_MS,
);

test(
  "a signal in the process kills the harness, writes the partial results first, and ends with 130",
  async () => {
    const box = sandbox();
    plant(box);
    const out = path.join(box.root, "results");
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    try {
      const running = box.cli(scoreArgs(box, "results", "--jobs", "1"));
      await until(
        () => linesIn(out).length === 1 && hanging(box),
        "bravo to hang",
      );
      process.emit("SIGINT");
      // The file was written inside the signal, before anything else could run.
      expect(readResults(out).partial).toEqual({ reason: "interrupted" });
      expect(readResults(out).records).toHaveLength(1);
      expect(exit).toHaveBeenCalledWith(INTERRUPTED);
      // The harness was killed, so the run ends and the command finishes.
      await running;
    } finally {
      exit.mockRestore();
    }
  },
  TEST_TIMEOUT_MS,
);

test("the hooks of a signal all run, a second signal exits at once, and a hook can be removed", () => {
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const order: string[] = [];
  const release = onDispose(() => undefined);
  const removed = onInterrupt(() => {
    order.push("removed");
  });
  removed();
  const offs = [
    onInterrupt(() => {
      order.push("first");
      throw new Error("hook broke");
    }),
    onInterrupt(() => {
      order.push("second");
      // A second signal while the first is being handled.
      process.emit("SIGTERM");
    }),
  ];
  try {
    process.emit("SIGINT");
    expect(order).toEqual(["first", "second"]);
    expect(error).toHaveBeenCalledWith(
      "skill-evals: interrupt hook failed: hook broke",
    );
    // Once from the second signal, once at the end of the first.
    expect(exit).toHaveBeenCalledTimes(2);
    expect(exit).toHaveBeenCalledWith(INTERRUPTED);
  } finally {
    for (const off of offs) off();
    release();
    exit.mockRestore();
    error.mockRestore();
  }
});

test("killRunning kills the process group of a command that is running", async () => {
  const running = exec(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    {
      cwd: process.cwd(),
      env: { PATH: process.env["PATH"] ?? "" },
      timeoutSeconds: 30,
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  killRunning();
  const ended = await running;
  expect(ended).toMatchObject({ signal: "SIGKILL", kind: null });
  // Nothing is left to kill.
  killRunning();
});
