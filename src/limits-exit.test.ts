import fs from "node:fs";
import { expect, test } from "vitest";
import { exec } from "./exec.js";
import { HARNESSES } from "./harnesses/index.js";
import type { Harness } from "./harnesses/shared.js";
import { session } from "./session.js";
import { sandbox } from "./testing/sandbox.js";

const TEST_TIMEOUT_MS = 30_000;
const LAG_MS = 500;
const CLAUDE = HARNESSES.find(
  (harness) => harness.id === "claude-code",
) as Harness;
const ENV = { PATH: process.env["PATH"] };
// A child that writes one line and exits with code 1 at once.
const CRASH = 'console.log("{}"); process.exit(1)';

/**
 * Blocks this process's event loop, as a runner that is behind with its events is blocked.
 * @param ms - How long.
 */
function block(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Busy: nothing else in this process runs, so the child's exit is certain to come first.
  }
}

test(
  "a child that writes the crossing chunk and exits 1 by itself while the runner lags was not stopped",
  async () => {
    const run = await exec(process.execPath, ["-e", CRASH], {
      cwd: process.cwd(),
      env: ENV,
      timeoutSeconds: 20,
      onStdout: () => {
        block(LAG_MS);
        return "stop";
      },
    });

    // The stop's kill reached a dead process; the exit code says the child ended first, and its failure is kept.
    expect(run).toMatchObject({ stopped: false, exit: 1, kind: null });
    expect(run.failure).toMatch(/^exit 1/);
  },
  TEST_TIMEOUT_MS,
);

test(
  "a child that writes the crossing chunk and then crashes with its own signal was not stopped",
  async () => {
    const crash = 'console.log("{}"); process.kill(process.pid, "SIGSEGV")';
    const run = await exec(process.execPath, ["-e", crash], {
      cwd: process.cwd(),
      env: ENV,
      timeoutSeconds: 20,
      onStdout: () => {
        block(LAG_MS);
        return "stop";
      },
    });

    expect(run).toMatchObject({
      stopped: false,
      signal: "SIGSEGV",
      kind: null,
    });
    expect(run.failure).toMatch(/^exit SIGSEGV/);
  },
  TEST_TIMEOUT_MS,
);

test(
  "a chunk that is read after the overdue timeout fired is a timeout, not a stop",
  async () => {
    // The child stays alive, so the timeout's kill ends it by a signal, as a runner's stop would.
    const child =
      'setTimeout(() => console.log("{}"), 200); setInterval(() => {}, 1000)';
    setImmediate(() => {
      // The timeout is due at 1 s; the event loop is back at 1.6 s, runs the overdue timer, and only then reads the pipe.
      block(1600);
    });
    const run = await exec(process.execPath, ["-e", child], {
      cwd: process.cwd(),
      env: ENV,
      timeoutSeconds: 1,
      onStdout: () => "stop",
    });

    expect(run).toMatchObject({ kind: "timeout", stopped: false });
    expect(run.failure).toBe("timed out after 1 s");
  },
  TEST_TIMEOUT_MS,
);

test.each([
  ["exit 1", "process.exit(1)"],
  ["a crash by its own signal", 'process.kill(process.pid, "SIGSEGV")'],
])(
  "a stream with three turns and no result, then %s, is a failed run even with maxTurns 2",
  async (_ending, end) => {
    const box = sandbox();
    const turn = (id: number) =>
      JSON.stringify({
        type: "assistant",
        message: {
          id: `m${String(id)}`,
          content: [{ type: "text", text: `t${String(id)}` }],
        },
      });
    const crash = box.write(
      "bin/crash.mjs",
      `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify([1, 2, 3].map(turn).join("\n") + "\n")});\n${end};\n`,
    );
    fs.chmodSync(crash, 0o755);
    // The counter blocks as the runner would when it is behind, so the process has exited before the stop is asked for.
    const lagging: Harness = {
      ...CLAUDE,
      countTurns: (line, state) => {
        block(LAG_MS);
        CLAUDE.countTurns?.(line, state);
      },
    };
    const ran = await session(
      {
        harness: lagging,
        bin: crash,
        subject: null,
        prompt: "x",
        maxTurns: 2,
        timeoutSeconds: 20,
      },
      (result) => result,
    );

    expect(ran.stoppedBy).toBe("agent");
    expect(ran.error).not.toBeNull();
  },
  TEST_TIMEOUT_MS,
);
