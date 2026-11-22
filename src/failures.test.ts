import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { CONFIG_FILE } from "./project.js";
import { plugin } from "./testing/plant.js";
import type { Sandbox } from "./testing/sandbox.js";
import {
  fakeHarness,
  fixture,
  readResults,
  sandbox,
} from "./testing/sandbox.js";

/**
 * Scores the "none" subject once on a case that any finished run passes.
 * @param box - Where the case goes.
 * @param env - Extra environment variables, which choose the harness executable.
 * @param caseFile - More keys for the case file.
 * @returns What the command did, and the one run record.
 */
async function scored(
  box: Sandbox,
  env: Record<string, string>,
  caseFile: Record<string, unknown> = {},
) {
  box.write("cases/hello/prompt.md", "say hello\n");
  const checks = [{ type: "output_not_contains", text: "no such text" }];
  box.write("cases/hello/case.json", { checks, ...caseFile });
  const outDir = path.join(box.root, "results");
  const flags = ["--cases", path.join(box.root, "cases"), "--reps", "1"];
  const result = await box.cli(
    ["score", "--subject", "none", ...flags, "--out", outDir],
    env,
  );
  return { result, record: readResults(outDir).records[0] };
}

const HEARTBEAT_WAIT_MS = 300;
// Long enough for the background process to start and beat on a loaded machine; the full suite runs files in parallel.
const TIMEOUT_SECONDS = 3;

test("a harness that outlasts the case's timeout is stopped with everything it started, and the run is invalid", async () => {
  const box = sandbox();
  const heartbeat = path.join(box.root, "heartbeat");
  const env = {
    SKILL_EVALS_BIN_CLAUDE_CODE: fixture("slow-harness.mjs"),
  };
  box.write(CONFIG_FILE, { env: ["SLOW_HEARTBEAT_FILE"] });
  const { result, record } = await scored(
    box,
    { ...env, SLOW_HEARTBEAT_FILE: heartbeat },
    { timeoutSeconds: TIMEOUT_SECONDS },
  );

  expect(result.status).toBe(1);
  expect(record).toMatchObject({
    ok: false,
    error: `timed out after ${String(TIMEOUT_SECONDS)} s`,
    score: null,
  });
  expect(result.stdout).toMatch(
    new RegExp(
      `^- SUBJECT \`hello\` rep 1: run failed: timed out after ${String(TIMEOUT_SECONDS)} s$`,
      "m",
    ),
  );
  // The process that the harness left in the background beat while it lived.
  const beats = fs.readFileSync(heartbeat, "utf8");
  expect(Number(beats)).toBeGreaterThan(0);
  await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_WAIT_MS));
  expect(fs.readFileSync(heartbeat, "utf8")).toBe(beats);
});

test("a harness executable that cannot start is a failed run, not a crash", async () => {
  const box = sandbox();
  const broken = box.write("broken-harness", "#!/no/such/interpreter\n");
  fs.chmodSync(broken, 0o755);
  const { result, record } = await scored(box, {
    SKILL_EVALS_BIN_CLAUDE_CODE: broken,
  });

  expect(result.status).toBe(1);
  expect(record?.error).toMatch(/ENOENT/);
  expect(result.stderr).toMatch(/^claude-code hello subject1: run failed: /);
});

test("a plugin that an adapter cannot prepare, or whose setup command fails, is a failed run", async () => {
  const box = sandbox();
  const bare = plugin(box, "plugin-bare", {});
  const out = ["--out", path.join(box.root, "probe")];
  const check = (subject: string) =>
    box.cli(["check", "--subject", subject, "--harness", "codex", ...out], {
      SKILL_EVALS_BIN_CODEX: fakeHarness,
    });

  const unprepared = await check(bare);
  expect(unprepared.status).toBe(1);
  expect(unprepared.stdout).toMatch(
    /^\| codex \| yes \| NO: could not prepare the run: ENOENT.*marketplace\.json/m,
  );

  // The fake harness is no Codex, so it fails the first `plugin marketplace add`.
  const listed = plugin(box, "plugin-listed", {});
  box.write("plugin-listed/.agents/plugins/marketplace.json", {
    name: "kit",
    plugins: [{ name: "magic" }],
  });
  const failedSetup = await check(listed);
  expect(failedSetup.status).toBe(1);
  expect(failedSetup.stdout).toMatch(
    /^\| codex \| yes \| NO: setup "plugin marketplace": exit 1: /m,
  );
});
