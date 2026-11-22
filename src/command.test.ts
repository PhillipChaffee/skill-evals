import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { runCommand } from "./command.js";
import type { Given } from "./testing/outcome.js";
import { dirsWith, scoredAsync } from "./testing/outcome.js";

const SECOND_MS = 1000;
const SHORT_MS = 10 * SECOND_MS;
const ENV = "/usr/bin/env";

test("stdoutMatches and expectExit", async () => {
  const dirs = dirsWith();
  const score = (check: Omit<Given, "type">) =>
    scoredAsync({ type: "command", ...check }, dirs.run());
  const base = { run: "echo ok 1; exit 3", expectExit: 3 };
  expect((await score({ ...base, stdoutMatches: "^ok " })).score).toBe(1);
  expect((await score({ ...base, stdoutMatches: "^no " })).score).toBe(0);
  expect((await score({ ...base, stdoutLacks: "^ok" })).score).toBe(0);
  const wrongExit = await score({ run: "echo ok 1; exit 3" });
  expect(wrongExit.score).toBe(0);
  expect(wrongExit.reason).toMatch(/^exit 3 in \d+ ms/);
  expect((await score({ run: "exit 0", expectExit: 0 })).score).toBe(1);
  const flagged = { ...base, stdoutMatches: "OK", flags: "i" };
  expect((await score(flagged)).score).toBe(1);
});

test("score stdout reads a ratio", async () => {
  const dirs = dirsWith();
  const ratio = (run: string, more: Partial<Given> = {}) =>
    scoredAsync({ type: "command", run, score: "stdout", ...more }, dirs.run());
  expect((await ratio("echo 0.75")).score).toBe(0.75);
  expect((await ratio("printf '1\\n0.5\\n\\n\\n'")).score).toBe(0.5);
  const words = await ratio("echo mutants killed");
  expect(words.score).toBe(0);
  expect(words.reason).toContain('"mutants killed"');
  const high = await ratio("echo 1.5");
  expect(high.score).toBe(0);
  expect(high.reason).toContain('"1.5"');
  expect((await ratio("")).score).toBe(0);
  const exit = await ratio("echo 0.9; exit 1");
  expect(exit.score).toBe(0);
  expect((await ratio("echo 0.9; exit 2", { expectExit: 2 })).score).toBe(0.9);
  expect((await ratio("echo 0.9", { stdoutMatches: "^1" })).score).toBe(0);
});

test("a command that cannot start scores 0 with the reason", async () => {
  const dirs = dirsWith();
  const out = dirs.run();
  fs.rmSync(dirs.workspace, { recursive: true });
  const gone = await scoredAsync({ type: "command", run: "true" }, out);
  expect(gone.score).toBe(0);
  expect(gone.reason).toMatch(/^could not start: /);
});

test("the command environment is the listed names and the case's own", async () => {
  const dirs = dirsWith({ "a.txt": "a" });
  const out = dirs.run();
  const seedDir = path.join(path.dirname(dirs.workspace), "seed");
  fs.mkdirSync(seedDir);
  const context = {
    workspace: dirs.workspace,
    graderDir: "/g",
    seedDir,
    home: dirs.home,
    transcriptFile: null,
    remoteDir: null,
    env: { CASE_FLAG: "1", TZ: "UTC" },
  };
  const result = await runCommand(ENV, { ...context }, 5);
  const names = result.stdout
    .split("\n")
    .map((line) => line.split("=")[0] ?? "")
    .filter(
      (name) => name !== "" && !["PWD", "SHLVL", "_", "OLDPWD"].includes(name),
    )
    .sort();
  expect(names).toEqual(
    [
      ...["PATH", "HOME", "TMPDIR", "LANG", "TZ", "CASE_FLAG"],
      ...["SKILL_EVALS_WORKSPACE", "SKILL_EVALS_GRADER_DIR"],
      ...["SKILL_EVALS_SEED_DIR", "SKILL_EVALS_HOME"],
      ...["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"],
      ...["GIT_AUTHOR_NAME", "GIT_COMMITTER_NAME"],
      ...["GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL"],
    ].sort(),
  );
  expect(result.stdout).toContain(`HOME=${dirs.home}`);
  expect(result.stdout).toContain("GIT_CONFIG_GLOBAL=/dev/null");
  expect(out.command.transcriptFile).toBeNull();
  const withBoth = await runCommand(
    ENV,
    { ...context, graderDir: null, transcriptFile: "/t.json", remoteDir: "/r" },
    5,
  );
  expect(withBoth.stdout).not.toContain("SKILL_EVALS_GRADER_DIR");
  expect(withBoth.stdout).toContain("SKILL_EVALS_TRANSCRIPT=/t.json");
  expect(withBoth.stdout).toContain("SKILL_EVALS_REMOTE_DIR=/r");
});

test(
  "a background process that a command leaves is killed with it",
  async () => {
    const started = Date.now();
    const out = dirsWith().run();
    const verdict = await scoredAsync(
      { type: "command", run: "/bin/sleep 300 & echo hi" },
      out,
    );
    expect(verdict.score).toBe(1);
    expect(Date.now() - started).toBeLessThan(SHORT_MS);
  },
  SHORT_MS * 2,
);

test("a command cut to its last 2,000 bytes keeps whole characters", async () => {
  const out = dirsWith().run();
  const verdict = await scoredAsync(
    {
      type: "command",
      run: "node -e \"process.stdout.write('x' + '€'.repeat(1000)); process.stderr.write('e'.repeat(2500) + 'END')\"",
      expectExit: 1,
    },
    out,
  );
  const { command } = verdict;
  expect(Buffer.byteLength(command?.stdout ?? "")).toBeLessThanOrEqual(2000);
  expect(command?.stdout).not.toContain("�");
  expect(command?.stdout.endsWith("€")).toBe(true);
  expect(command?.stderr).toHaveLength(2000);
  expect(command?.stderr.endsWith("END")).toBe(true);
  expect(verdict.reason).toMatch(/^exit 0 in \d+ ms/);
  expect(verdict.reason?.endsWith("END")).toBe(true);
});
