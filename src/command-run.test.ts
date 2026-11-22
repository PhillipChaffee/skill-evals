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

const PARSE_BUGGY = "export const parse = (text) => text.split(',');\n";
const PARSE_FIXED =
  "export const parse = (text) => text.split(',').map(Number);\n";
const HELD_OUT = `const { parse } = await import(process.env.SKILL_EVALS_WORKSPACE + "/src/parse.mjs");
const got = JSON.stringify(parse("1,2"));
if (got !== "[1,2]") { console.error("got " + got); process.exit(1); }
console.log("ok held-out");
`;
// Everything under the temp directory root and the workspace, except the case's own source directory: that one is
// where the author keeps the file, and only the sandbox of Task 30 can hide it from an agent that searches the disk.
const FIND_THE_GRADER = `find ${os.tmpdir()} . -path '*/cases' -prune -o -name held-out.mjs -print 2>/dev/null; true`;

test("a held-out grader that the workspace never held passes after the agent's fix", async () => {
  const check = {
    type: "command",
    run: 'node "$SKILL_EVALS_GRADER_DIR/held-out.mjs"',
    stdoutMatches: "^ok ",
  };
  const fix = {
    call: {
      name: "Write",
      input: { file_path: "src/parse.mjs" },
      write: { path: "src/parse.mjs", content: PARSE_FIXED },
    },
  };
  const fixed = await ran(sandbox(), {
    checks: [check],
    grader: { "held-out.mjs": HELD_OUT },
    workspace: { "src/parse.mjs": PARSE_BUGGY, "decoy/held-out.mjs": "x" },
    agent: [agentRuns(FIND_THE_GRADER), fix],
  });
  expect(fixed.results?.records[0]?.checks[0]?.score).toBe(1);
  expect(fixed.results?.invalid).toEqual([]);
  const stream = fs.readFileSync(
    path.join(fixed.out, "claude-code/restate/subject1.stream.jsonl"),
    "utf8",
  );
  const found = stream
    .split("\n")
    .filter((line) => line.includes("tool_result"))
    .map((line) => line);
  expect(found).toHaveLength(2);
  // The positive control: the same search does find a file of that name where the agent can see it, and finds nothing
  // else, so the held-out copy was nowhere it looked.
  expect(found[0]).toContain("./decoy/held-out.mjs\\n");
  // The decoy is in the workspace, so its copies (the workspace itself and the seed copy) are found too; nothing else is.
  const paths = found[0]?.match(/[^"\\]*held-out\.mjs/g) ?? [];
  expect(paths.length).toBeGreaterThan(0);
  expect(paths.every((one) => one.endsWith("decoy/held-out.mjs"))).toBe(true);
  const unfixed = await ran(sandbox(), {
    checks: [check],
    grader: { "held-out.mjs": HELD_OUT },
    workspace: { "src/parse.mjs": PARSE_BUGGY },
  });
  const [result] = unfixed.results?.records[0]?.checks ?? [];
  expect(result?.score).toBe(0);
  expect(result?.reason).toMatch(/^exit 1 in \d+ ms/);
  expect(result?.command?.stderr).toContain("got");
});

test("a git query that prints nothing", async () => {
  const check = {
    type: "command",
    run: "git status --porcelain",
    stdoutLacks: ".",
  };
  const init = agentRuns(
    "git init -q && git add -A && git -c user.name=t -c user.email=t@example.invalid commit -qm x",
  );
  const clean = await ran(sandbox(), { checks: [check], agent: [init] });
  expect(clean.results?.records[0]?.checks[0]?.score).toBe(1);
  const dirty = await ran(sandbox(), {
    checks: [check],
    agent: [agentRuns("git init -q && echo x > loose.txt")],
  });
  expect(dirty.results?.records[0]?.checks[0]?.score).toBe(0);
});

test("a command that times out scores 0 and the run stays valid", async () => {
  const got = await ran(sandbox(), {
    checks: [{ type: "command", run: "/bin/sleep 5", timeoutSeconds: 1 }],
  });
  const [record] = got.results?.records ?? [];
  expect(typeof record?.score).toBe("number");
  expect(record?.checks[0]?.score).toBe(0);
  expect(got.results?.invalid).toEqual([]);
  expect(record?.checks[0]?.reason).toMatch(/timed out after 1 s/);
  expect(record?.checks[0]?.command?.exit).toBeNull();
});

test("a command that cannot start scores 0", async () => {
  const missing = await ran(sandbox(), {
    checks: [{ type: "command", run: "/nonexistent/x" }],
  });
  expect(missing.results?.records[0]?.checks[0]?.score).toBe(0);
  expect(missing.results?.invalid).toEqual([]);
});

test("the command environment holds no provider key", async () => {
  const got = await ran(sandbox(), {
    checks: [{ type: "command", run: "/usr/bin/env" }],
    env: { ANTHROPIC_API_KEY: "sk-secret", CUSTOM_TOKEN: "t" },
  });
  const stdout = got.results?.records[0]?.checks[0]?.command?.stdout ?? "";
  expect(stdout).toContain("SKILL_EVALS_WORKSPACE=");
  expect(stdout).not.toContain("ANTHROPIC_API_KEY");
  expect(stdout).not.toContain("sk-secret");
  expect(stdout).not.toContain("CUSTOM_TOKEN");
});

test(
  "a background process the agent left does not block the grader",
  async () => {
    const got = await ran(sandbox(), {
      checks: [{ type: "command", run: "true" }],
      agent: [agentRuns("/bin/sleep 300 &")],
    });
    expect(got.results?.records[0]?.checks[0]?.score).toBe(1);
  },
  SHORT_MS,
);

const LINT_MESSAGE = "no-var: src/a.mjs";
const MUTATION = {
  type: "command",
  run: 'git apply "$SKILL_EVALS_GRADER_DIR/bad.patch" && node lint.mjs',
  expectExit: 1,
  stdoutMatches: LINT_MESSAGE,
};
const BAD_PATCH = [
  "--- a/src/a.mjs",
  "+++ b/src/a.mjs",
  "@@ -1 +1 @@",
  "-const a = 1;",
  "+var a = 1;",
  "",
].join("\n");
const LINT = `import fs from "node:fs";
if (fs.readFileSync("src/a.mjs", "utf8").includes("var ")) {
  console.log("${LINT_MESSAGE}");
  process.exit(1);
}
`;

test("a mutation grader needs the lint rule's own message, so a missing or lax lint scores 0", async () => {
  const mutated = (workspace: Record<string, string>) =>
    ran(sandbox(), {
      checks: [MUTATION],
      grader: { "bad.patch": BAD_PATCH },
      workspace: { "src/a.mjs": "const a = 1;\n", ...workspace },
    });
  const caught = await mutated({ "lint.mjs": LINT });
  expect(caught.results?.records[0]?.checks[0]?.score).toBe(1);
  const lax = await mutated({ "lint.mjs": "process.exit(0);\n" });
  expect(lax.results?.records[0]?.checks[0]?.score).toBe(0);
  const missing = await mutated({});
  expect(missing.results?.records[0]?.checks[0]?.score).toBe(0);
});

test("commands run in case order and see each other's effects", async () => {
  const got = await ran(sandbox(), {
    checks: [
      { type: "command", run: "echo made > marker.txt" },
      { type: "command", run: "test -f marker.txt" },
    ],
  });
  expect(got.results?.records[0]?.checks.map((c) => c.score)).toEqual([1, 1]);
});

test("the seed copy is the workspace before the agent ran, and the grader copy is a plain temp dir that goes away", async () => {
  const check = {
    type: "command",
    run: '/bin/cat "$SKILL_EVALS_SEED_DIR/notes.txt"; echo "dir=$SKILL_EVALS_GRADER_DIR"; /bin/cat notes.txt',
  };
  const edit = {
    call: {
      name: "Write",
      input: { file_path: "notes.txt" },
      write: { path: "notes.txt", content: "changed\n" },
    },
  };
  const got = await ran(sandbox(), {
    checks: [check],
    grader: { "g.txt": "x" },
    agent: [edit],
  });
  const stdout = got.results?.records[0]?.checks[0]?.command?.stdout ?? "";
  expect(stdout).toMatch(/^planted\ndir=.*\nchanged\n$/);
  const dir = /dir=(.*)\n/.exec(stdout)?.[1] ?? "";
  expect(path.basename(dir)).not.toMatch(/grader|eval|test|judge|score/i);
  expect(path.dirname(dir)).not.toContain("restate");
  expect(fs.existsSync(dir)).toBe(false);
});

test("a run that is invalid does not run its commands, and its reason stays the harness's", async () => {
  const got = await ran(sandbox(), {
    checks: [
      { type: "command", run: "echo ran > ran.txt" },
      { type: "output_contains", text: "x" },
    ],
    agent: [{ fail: "boom" }],
  });
  const [record] = got.results?.records ?? [];
  expect(record?.checks[0]).toMatchObject({
    score: null,
    reason: "not run, because the run is invalid",
  });
  expect(record?.score).toBeNull();
  expect(got.results?.invalid).toHaveLength(1);
  expect(got.results?.invalid[0]).toContain("run failed");
  expect(got.results?.invalid[0]).toContain("boom");
});

test("a grader directory inside workspace/ is a load error", async () => {
  const box = sandbox();
  const cases = plantCase(box, [{ type: "command", run: "true" }]);
  box.write("cases/restate/workspace/grader/x.mjs", "x");
  const result = await box.cli(["validate", "--cases", cases]);
  expect(result.status).not.toBe(0);
  expect(result.stdout + result.stderr).toMatch(/workspace\/grader/);
});
