import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { scoreGraded as ran } from "./testing/graded.js";
import { plantCase } from "./testing/plant.js";
import { exec as agentRuns } from "./testing/runs.js";
import { sandbox } from "./testing/sandbox.js";

const SECOND_MS = 1000;
const SHORT_MS = 10 * SECOND_MS;

test("the setting stays in the record beside the result's own score", async () => {
  const got = await ran(sandbox(), {
    checks: [{ type: "command", run: "echo 0.25", scoreFrom: "stdout" }],
  });
  expect(got.results?.records[0]?.checks[0]).toMatchObject({
    scoreFrom: "stdout",
    score: 0.25,
  });
});

test(
  "a command that prints far more than the cap is cut, and a pattern that overflows scores 0 with the run valid",
  async () => {
    const big = (bytes: number, more: Record<string, unknown>) =>
      ran(sandbox(), {
        checks: [
          {
            type: "command",
            run: `/usr/bin/yes abcdefghi | /usr/bin/head -c ${String(bytes)}`,
            ...more,
          },
        ],
      });
    const overflow = await big(10 * 1024 * 1024, {
      stdoutMatches: "(.|\\n)*passed",
    });
    const [check] = overflow.results?.records[0]?.checks ?? [];
    expect(check?.score).toBe(0);
    expect(check?.reason).toMatch(/^the check could not be scored: /);
    expect(overflow.results?.invalid).toEqual([]);
    const huge = await big(600 * 1024 * 1024, {});
    const [capped] = huge.results?.records[0]?.checks ?? [];
    expect(capped?.command?.truncated).toBe(true);
    expect(capped?.command?.stdout.length).toBeLessThanOrEqual(2000);
    expect(capped?.reason).toMatch(/output cut at 5 MB/);
    expect(capped?.score).toBe(1);
  },
  SHORT_MS * 6,
);

test("an agent that writes into the seed copy makes the command checks score 0", async () => {
  // A name of its own, so that this test cannot touch the seed copy of a run in another test file.
  const name = `tamper-${randomUUID()}.txt`;
  const find = `find ${os.tmpdir()} -maxdepth 2 -path '*/copy-*' -name ${name}`;
  const got = await ran(sandbox(), {
    checks: [{ type: "command", run: "true" }],
    workspace: { [name]: "planted\n" },
    agent: [
      agentRuns(`for f in $(${find}); do chmod u+w $f; echo x > $f; done`),
    ],
  });
  const [check] = got.results?.records[0]?.checks ?? [];
  expect(check?.score).toBe(0);
  expect(check?.reason).toBe(`the seed copy was changed: ${name}`);
  expect(got.results?.invalid).toEqual([]);
});

test("a command that writes into the seed copy spoils the next command check", async () => {
  const got = await ran(sandbox(), {
    checks: [
      {
        type: "command",
        run: '/bin/chmod -R u+w "$SKILL_EVALS_SEED_DIR" && echo x > "$SKILL_EVALS_SEED_DIR/notes.txt"',
      },
      { type: "command", run: "true" },
    ],
  });
  const [first, second] = got.results?.records[0]?.checks ?? [];
  expect(first?.score).toBe(1);
  expect(second?.score).toBe(0);
  expect(second?.reason).toMatch(/^the seed copy was changed: notes.txt/);
});

test("the login files are gone from the home before a command runs, and results.json holds no secret", async () => {
  const box = sandbox();
  const secret = "sk-login-secret";
  box.write(".claude/.credentials.json", secret);
  const read = '/bin/cat "$HOME/.claude/.credentials.json"';
  const got = await ran(box, {
    checks: [{ type: "command", run: read, expectExit: 1 }],
    agent: [agentRuns(read)],
  });
  const stream = fs.readFileSync(
    path.join(got.out, "claude-code/restate/subject1.stream.jsonl"),
    "utf8",
  );
  expect(stream).toContain(secret);
  expect(got.results?.records[0]?.checks[0]?.score).toBe(1);
  expect(got.results?.records[0]?.checks[0]?.command?.stdout).toBe("");
  expect(
    fs.readFileSync(path.join(got.out, "results.json"), "utf8"),
  ).not.toContain(secret);
});

test("commands are scored after every other check, and the record keeps the case's order", async () => {
  const got = await ran(sandbox(), {
    checks: [
      { type: "command", run: "echo mutated > notes.txt" },
      { type: "file_matches", path: "notes.txt", pattern: "^planted" },
      { type: "file_unchanged", path: "notes.txt" },
    ],
  });
  const checks = got.results?.records[0]?.checks ?? [];
  expect(checks.map((check) => check.type)).toEqual([
    "command",
    "file_matches",
    "file_unchanged",
  ]);
  expect(checks.map((check) => check.score)).toEqual([1, 1, 1]);
});

test("a grader that is a plain file is a load error", async () => {
  const box = sandbox();
  const cases = plantCase(box, [{ type: "command", run: "true" }]);
  box.write("cases/restate/grader", "not a directory");
  const result = await box.cli(["validate", "--cases", cases]);
  expect(result.status).not.toBe(0);
  expect(result.stdout + result.stderr).toMatch(/grader must be a directory/);
});

const CREDENTIALS = ".claude/.credentials.json";

test("a login that cannot be removed, or was replaced by a directory, never crashes the run", async () => {
  const box = sandbox();
  box.write(CREDENTIALS, "sk-x");
  const swapped = await ran(box, {
    checks: [
      {
        type: "command",
        run: "/bin/ls -d $HOME/.claude/.credentials.json",
        expectExit: 2,
      },
    ],
    agent: [agentRuns(`rm -f ~/${CREDENTIALS}; mkdir -p ~/${CREDENTIALS}`)],
  });
  expect(swapped.results?.records[0]?.checks[0]?.score).toBe(1);
  const stuck = sandbox();
  stuck.write(CREDENTIALS, "sk-x");
  const remove = fs.rmSync;
  const spy = vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
    if (String(target).endsWith(CREDENTIALS)) throw new Error("EBUSY: locked");
    remove(target, options);
  });
  try {
    const got = await ran(stuck, {
      checks: [
        { type: "command", run: "true" },
        { type: "command", run: "true" },
      ],
    });
    const checks = got.results?.records[0]?.checks ?? [];
    expect(checks.map((check) => check.score)).toEqual([0, 0]);
    expect(checks[0]?.reason).toBe(
      "the login could not be removed from the home: EBUSY: locked",
    );
  } finally {
    spy.mockRestore();
  }
});

test("a throw while a run is scored becomes an invalid record, not a rejection", async () => {
  const write = fs.writeFileSync;
  const spy = vi
    .spyOn(fs, "writeFileSync")
    .mockImplementation((file, data, options) => {
      if (String(file).endsWith(".stream.jsonl")) throw new Error("disk full");
      write(file, data, options);
    });
  try {
    const got = await ran(sandbox(), {
      checks: [{ type: "command", run: "true" }],
    });
    const [record] = got.results?.records ?? [];
    expect(record?.error).toBe("the run could not be scored: disk full");
    expect(record?.score).toBeNull();
    expect(got.results?.invalid).toHaveLength(1);
  } finally {
    spy.mockRestore();
  }
});

test("a seed copy keeps execute bits, so a script runs from it and a diff against it is empty", async () => {
  const got = await ran(sandbox(), {
    checks: [
      {
        type: "command",
        run: '"$SKILL_EVALS_SEED_DIR/check.sh"',
        stdoutMatches: "^ok",
      },
      {
        type: "command",
        run: 'git diff --no-index "$SKILL_EVALS_SEED_DIR" .',
        stdoutLacks: ".",
      },
    ],
    workspace: { "check.sh": "#!/bin/sh\necho ok\n" },
    executable: ["check.sh"],
  });
  const checks = got.results?.records[0]?.checks ?? [];
  expect(checks.map((check) => check.score)).toEqual([1, 1]);
});
