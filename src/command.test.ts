import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { copiesForCommands, runCommand } from "./command.js";
import type { Given } from "./testing/outcome.js";
import { dirsWith, scoredAsync, scoredNow } from "./testing/outcome.js";

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
    scoredAsync(
      { type: "command", run, scoreFrom: "stdout", ...more },
      dirs.run(),
    );
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
  // A file where the workspace was: the directory exists no more, and the shell cannot start in it.
  fs.rmSync(dirs.workspace, { recursive: true });
  fs.writeFileSync(dirs.workspace, "");
  const gone = await scoredAsync({ type: "command", run: "true" }, out);
  expect(gone.score).toBe(0);
  expect(gone.reason).toMatch(/^could not start: /);
});

test("the command environment is the listed names and the case's own", async () => {
  const dirs = dirsWith({ "a.txt": "a" });
  const out = dirs.run();
  const { seedDir } = out.command;
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
      ...["GIT_OPTIONAL_LOCKS", "GIT_CEILING_DIRECTORIES"],
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
  const noSeed = await runCommand(ENV, { ...context, seedDir: null }, 5);
  expect(noSeed.stdout).not.toContain("SKILL_EVALS_SEED_DIR");
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

/**
 * Makes shell text that starts a session leader holding the command's pipes open, and kills it when the test ends.
 * @returns A shell command to put in the background.
 */
function daemonThatOutlivesTheTest(): string {
  const pidFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "daemon-")),
    "pid",
  );
  onTestFinished(() => {
    try {
      process.kill(Number(fs.readFileSync(pidFile, "utf8")), "SIGKILL");
    } catch {
      // It was never started, or it is gone.
    }
    fs.rmSync(path.dirname(pidFile), { recursive: true, force: true });
  });
  return `setsid sh -c 'echo $$ > ${pidFile}; exec /bin/sleep 317'`;
}

test(
  "a daemon that left the process group and holds the pipes does not hold the check",
  async () => {
    const daemon = daemonThatOutlivesTheTest();
    const started = Date.now();
    const out = dirsWith().run();
    const verdict = await scoredAsync(
      {
        type: "command",
        run: `${daemon} & /bin/sleep 1000`,
        timeoutSeconds: 1,
      },
      out,
    );
    expect(verdict.score).toBe(0);
    expect(verdict.reason).toMatch(/^timed out after 1 s/);
    expect(Date.now() - started).toBeLessThan(5 * SECOND_MS);
  },
  SHORT_MS,
);

test(
  "a daemon that outlives a command that exited does not hold the check either",
  async () => {
    const daemon = daemonThatOutlivesTheTest();
    const out = dirsWith().run();
    const verdict = await scoredAsync(
      { type: "command", run: `${daemon} & echo hi` },
      out,
    );
    expect(verdict.score).toBe(1);
    expect(verdict.command?.stdout).toBe("hi\n");
  },
  SHORT_MS,
);

test("a command that a signal ended, and one that timed out, say so with the end of stderr", async () => {
  const out = dirsWith().run();
  const killed = await scoredAsync({ type: "command", run: "kill -9 $$" }, out);
  expect(killed.score).toBe(0);
  expect(killed.reason).toMatch(
    /^killed by SIGKILL in \d+ ms, expected exit 0/,
  );
  const slow = await scoredAsync(
    {
      type: "command",
      run: "echo oops >&2; /bin/sleep 5",
      timeoutSeconds: 1,
    },
    out,
  );
  expect(slow.reason).toBe("timed out after 1 s: oops");
});

test("a workspace the agent deleted says so", async () => {
  const dirs = dirsWith();
  const out = dirs.run();
  fs.rmSync(dirs.workspace, { recursive: true });
  const gone = await scoredAsync({ type: "command", run: "true" }, out);
  expect(gone).toEqual({ score: 0, reason: "the workspace no longer exists" });
});

test("without a seed copy there is no seed variable, and a seed copy that cannot be made leaves nothing behind", () => {
  const before = fs
    .readdirSync(os.tmpdir())
    .filter((n) => n.startsWith("copy-"));
  expect(() => copiesForCommands("/nonexistent/workspace", null)).toThrow();
  const after = fs
    .readdirSync(os.tmpdir())
    .filter((n) => n.startsWith("copy-"));
  expect(after).toEqual(before);
});

test("scoredNow refuses a check that waits for a process", () => {
  const out = dirsWith().run();
  expect(() =>
    scoredNow({ type: "command", run: "true", weight: 1 }, out),
  ).toThrow(/scoredAsync/);
});

test("a seed copy that is missing, or changed in many files, is named", async () => {
  const many = Object.fromEntries(
    Array.from({ length: 12 }, (_, index) => [`f${String(index)}.txt`, "x"]),
  );
  const out = dirsWith(many).run();
  const none = await scoredAsync(
    { type: "command", run: "true" },
    { ...out, command: { ...out.command, seedDir: null } },
  );
  expect(none.score).toBe(1);
  fs.rmSync(out.command.seedDir ?? "", { recursive: true });
  const gone = await scoredAsync({ type: "command", run: "true" }, out);
  expect(gone.reason).toMatch(/^the seed copy was changed: .*and 2 more$/);
});
