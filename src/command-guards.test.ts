import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
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
    expect(check?.reason).toMatch(/could not be scored|does not match/);
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

const TAMPER =
  "for f in $(find $DIR -maxdepth 2 -path '*/copy-*' -name notes.txt); do chmod u+w $f; echo tampered > $f; done";

test("an agent that writes into the seed copy makes the command checks score 0", async () => {
  const got = await ran(sandbox(), {
    checks: [{ type: "command", run: "true" }],
    agent: [agentRuns(TAMPER.replace("$DIR", os.tmpdir()))],
  });
  const [check] = got.results?.records[0]?.checks ?? [];
  expect(check?.score).toBe(0);
  expect(check?.reason).toBe("the seed copy was changed: notes.txt");
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
