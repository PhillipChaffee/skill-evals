import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { EXIT } from "./exit-codes.js";
import type { Summary } from "./summary.js";
import { scoreArgs, scriptedCase } from "./testing/budget.js";
import { fixture, sandbox } from "./testing/sandbox.js";
import { linesIn } from "./testing/suite.js";

const RESULTS = "results";
const ALPHA = "alpha";
const TEST_TIMEOUT_MS = 60_000;
const POLL_MS = 25;
const WAIT_MS = 30_000;
const summaryOf = (out: string): Summary =>
  JSON.parse(
    fs.readFileSync(path.join(out, "summary.json"), "utf8"),
  ) as Summary;

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

// Type stripping, which the child needs to run the sources, is on by default from Node 22.18.
test.skipIf(!process.features.typescript)(
  "exit 130: a signal ends the command, and summary.json says interrupted",
  async () => {
    const box = sandbox();
    scriptedCase(box, ALPHA);
    scriptedCase(box, "bravo", {
      before: [{ onStart: [1], step: { hang: true } }],
    });
    const out = path.join(box.root, RESULTS);
    const child = spawn(
      process.execPath,
      [
        ...["--import", fixture("ts-register.mjs")],
        path.resolve(import.meta.dirname, "bin.ts"),
        ...scoreArgs(box, RESULTS, "--jobs", "1"),
      ],
      { cwd: box.root, env: box.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    onTestFinished(() => {
      child.kill("SIGKILL");
    });
    await until(
      () =>
        fs.existsSync(path.join(out, "results.jsonl")) &&
        linesIn(out).length === 1 &&
        fs.existsSync(path.join(box.root, "fake/starts/case-bravo.json")),
      "the first run to finish and the second to hang",
    );
    // Writes while the command runs are interim: they never make a summary.
    expect(fs.existsSync(path.join(out, "summary.json"))).toBe(false);
    child.kill("SIGINT");
    const [code] = (await once(child, "exit")) as [number | null];
    expect(code).toBe(EXIT.interrupted);
    expect(summaryOf(out)).toMatchObject({
      exit: 130,
      partial: "interrupted",
    });
  },
  TEST_TIMEOUT_MS,
);
