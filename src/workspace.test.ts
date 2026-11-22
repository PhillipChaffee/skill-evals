import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { loadCases } from "./cases.js";
import { script, skillsFolder } from "./testing/plant.js";
import { exec as agentRuns } from "./testing/runs.js";
import { readResults, sandbox } from "./testing/sandbox.js";
import { go, printed } from "./testing/setup.js";

const INVALID_RUNS = 1;

const BUILD_HISTORY = `set -e
git checkout -q -b feature/clean-me
for n in 1 2 3 4 5 6; do echo "$n" >> notes.txt; git add -A; git commit -q -m "wip $n"; done
`;

test("a case starts on a feature branch with seven commits and an origin remote", async () => {
  const box = sandbox();
  const got = await go(box, {
    case: {
      setup: [
        { git: { init: true, commitAll: "initial", remote: "origin" } },
        { run: 'sh "$SKILL_EVALS_FIXTURE_DIR/build-history.sh"' },
      ],
    },
    files: {
      "fixture/build-history.sh": BUILD_HISTORY,
      "workspace/app.txt": "a\n",
    },
    agent: [
      agentRuns(
        'git log --oneline | wc -l; git remote get-url origin; git branch --show-current; ls fixture 2>&1; echo "ls=$?"; git log --all --name-only --format= | grep -c build-history; true',
      ),
    ],
  });
  expect(got.status, got.stderr).toBe(0);
  expect(got.results?.invalid).toEqual([]);
  const [text] = printed(got.out);
  expect(text).toMatch(/^\s*7\n/);
  expect(text).toMatch(/\/store-[^/\n]+\/origin\.git\n/);
  expect(text).toContain("feature/clean-me\n");
  expect(text).toContain("ls=2");
  expect(text).toMatch(/\n0\n$/);
  expect(text).not.toContain(box.root + "/cases");
});

test("home seeds a user-level file and root home can assert on it", async () => {
  const box = sandbox();
  const got = await go(box, {
    case: {
      home: "home",
      checks: [
        {
          type: "file_matches",
          root: "home",
          path: ".config/tool/settings.json",
          pattern: "dark",
        },
        {
          type: "file_unchanged",
          root: "home",
          path: ".config/tool/settings.json",
        },
      ],
    },
    files: { "home/.config/tool/settings.json": '{"theme":"dark"}\n' },
    agent: [agentRuns('cat "$HOME/.config/tool/settings.json"')],
  });
  expect(got.results?.records[0]?.checks.map((check) => check.score)).toEqual([
    1, 1,
  ]);
  expect(printed(got.out)[0]).toContain('"theme":"dark"');
});

test("twenty cases share one fixture directory", async () => {
  const box = sandbox();
  box.write("cases/_shared/shop-core/package.json", '{"name":"shop-core"}\n');
  for (let n = 1; n <= 20; n += 1) {
    const id = `shop/case-${String(n).padStart(2, "0")}`;
    box.write(`cases/${id}/prompt.md`, "work on the shop\n");
    box.write(`cases/${id}/case.json`, {
      fixtures: ["../../_shared"],
      checks: [{ type: "file_exists", path: "shop-core/package.json" }],
    });
  }
  const cases = loadCases(path.join(box.root, "cases"));
  expect(cases).toHaveLength(20);
  expect(cases.some((one) => one.id.includes("_shared"))).toBe(false);
  script(box, "agent", { turns: [[{ final: "done" }]] });
  const subject = skillsFolder(box, "skills", { bro: "# bro\n" });
  const out = path.join(box.root, "results");
  const ran = await box.cli([
    ...["score", "--subject", subject, "--cases", path.join(box.root, "cases")],
    ...["--reps", "1", "--out", out],
  ]);
  expect(ran.status, ran.stderr).toBe(0);
  const { records } = readResults(out);
  expect(records).toHaveLength(20);
  expect(records.every((record) => record.score === 1)).toBe(true);
});

test("a later layer wins: fixtures in order, then workspace", async () => {
  const box = sandbox();
  box.write("cases/_shared/one/a.txt", "fixture\n");
  box.write("cases/_shared/one/b.txt", "first\n");
  box.write("cases/_shared/two/b.txt", "second\n");
  const got = await go(box, {
    case: {
      fixtures: ["../_shared/one", "../_shared/two"],
      checks: [
        { type: "file_matches", path: "a.txt", pattern: "^workspace" },
        { type: "file_matches", path: "b.txt", pattern: "^second" },
      ],
    },
    files: { "workspace/a.txt": "workspace\n" },
  });
  expect(got.results?.records[0]?.checks.map((check) => check.score)).toEqual([
    1, 1,
  ]);
});

test("a failed setup step invalidates the run and the harness never starts", async () => {
  const box = sandbox();
  const got = await go(box, {
    case: {
      setup: [{ run: "touch ok.txt" }, { run: "echo broken >&2; exit 3" }],
    },
  });
  expect(fs.existsSync(box.started)).toBe(false);
  const [first] = got.results?.invalid ?? [];
  expect(first).toMatch(
    /setup failed: step 2 \(echo broken >&2; exit 3\): exit 3: broken/,
  );
  expect(got.results?.records[0]?.score).toBeNull();
});

test("a setup step that runs too long fails the run", async () => {
  const box = sandbox();
  const got = await go(box, {
    case: { setup: [{ run: "sleep 5", timeoutSeconds: 1 }] },
  });
  expect(got.results?.invalid[0]).toMatch(
    /setup failed: step 1 \(sleep 5\): timed out after 1 s/,
  );
});

test("setup gets the command environment and the remote and fixture directories, never the grader or the seed", async () => {
  const box = sandbox();
  const got = await go(box, {
    case: {
      env: { CASE_MODE: "x" },
      setup: [{ run: "env | sort > seen-env.txt" }],
      checks: [
        {
          type: "command",
          run: "cat seen-env.txt",
          stdoutMatches: "CASE_MODE=x",
        },
        {
          type: "command",
          run: "grep -c GRADER_DIR seen-env.txt; true",
          stdoutMatches: "^0",
        },
        {
          type: "command",
          run: "grep -c SEED_DIR seen-env.txt; true",
          stdoutMatches: "^0",
        },
        {
          type: "command",
          run: "grep -c ANTHROPIC seen-env.txt; true",
          stdoutMatches: "^0",
        },
        {
          type: "command",
          run: "grep -c '^SKILL_EVALS_REMOTE_DIR=' seen-env.txt",
          stdoutMatches: "^1",
        },
        {
          type: "command",
          run: "grep -c '^SKILL_EVALS_FIXTURE_DIR=' seen-env.txt",
          stdoutMatches: "^1",
        },
        {
          type: "command",
          run: "grep -c '^GIT_CONFIG_GLOBAL=/dev/null' seen-env.txt",
          stdoutMatches: "^1",
        },
      ],
    },
    files: { "grader/x.txt": "x", "fixture/x.txt": "x" },
    env: { ANTHROPIC_API_KEY: "sk-secret" },
  });
  expect(got.results?.records[0]?.checks.map((check) => check.score)).toEqual([
    1, 1, 1, 1, 1, 1, 1,
  ]);
});

test("command checks reach the remote directory, and the seed holds what setup made", async () => {
  const box = sandbox();
  const got = await go(box, {
    case: {
      setup: [
        { git: { init: true, commitAll: "initial", remote: "origin" } },
        { run: "echo made > made.txt" },
      ],
      checks: [
        {
          type: "command",
          run: 'git --git-dir "$SKILL_EVALS_REMOTE_DIR/origin.git" rev-parse --verify main >/dev/null && echo "$SKILL_EVALS_REMOTE_DIR"',
          stdoutMatches: "/store-",
        },
        {
          type: "command",
          run: 'test -d "$SKILL_EVALS_SEED_DIR/.git" && test -f "$SKILL_EVALS_SEED_DIR/made.txt"',
        },
      ],
    },
    files: { "workspace/app.txt": "a\n" },
  });
  const [first, second] = got.results?.records[0]?.checks ?? [];
  expect([first?.score, second?.score]).toEqual([1, 1]);
  expect(got.results?.records[0]?.changedFiles).toEqual({
    created: [],
    modified: [],
    deleted: [],
  });
  const remote = first?.command?.stdout.trim() ?? "";
  expect(remote).not.toBe("");
  expect(fs.existsSync(remote)).toBe(false);
});

test("a case's fixture directory is not in the workspace and is removed after setup", async () => {
  const box = sandbox();
  const got = await go(box, {
    case: {
      setup: [
        {
          run: 'echo "$SKILL_EVALS_FIXTURE_DIR" > ../where.txt; cp "$SKILL_EVALS_FIXTURE_DIR/x.txt" copied.txt',
        },
      ],
    },
    files: { "fixture/x.txt": "x\n" },
    agent: [agentRuns('ls; ls "$(cat ../where.txt)" 2>&1; echo "ls=$?"')],
  });
  expect(got.results?.invalid).toEqual([]);
  const [listing] = printed(got.out);
  expect(listing).toContain("copied.txt");
  expect(listing).not.toMatch(/^fixture$/m);
  expect(listing).toMatch(/assets-[^\n]*No such file[^\n]*\nls=[1-9]/);
});

test("layers that cannot be merged make a run record with the error, not a crash", async () => {
  const box = sandbox();
  box.write("cases/_shared/one/a/x.txt", "x");
  box.write(
    "cases/_shared/two/a",
    "a file where the other layer has a directory",
  );
  const got = await go(box, {
    case: { fixtures: ["../_shared/one", "../_shared/two"] },
  });
  expect(got.status).toBe(INVALID_RUNS);
  expect(got.results?.invalid[0]).toMatch(/run failed: /);
  expect(fs.existsSync(box.started)).toBe(false);
});
