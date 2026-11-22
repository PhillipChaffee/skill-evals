import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { exec as agentRuns } from "./testing/runs.js";
import { sandbox } from "./testing/sandbox.js";
import { go, printed } from "./testing/setup.js";

const APP = { "workspace/app.txt": "a\n" };

test("four linked worktrees live under the remote directory and differ from each other", async () => {
  const box = sandbox();
  const make = [
    'W="$SKILL_EVALS_REMOTE_DIR"',
    'git worktree add -q "$W/wt-dirty" -b wt-dirty && echo x >> "$W/wt-dirty/app.txt"',
    'git worktree add -q --detach "$W/wt-detached"',
    'git worktree add -q "$W/wt-locked" -b wt-locked && git worktree lock "$W/wt-locked"',
    'git worktree add -q "$W/wt-ahead" -b wt-ahead && echo y > "$W/wt-ahead/b.txt" && git -C "$W/wt-ahead" add -A && git -C "$W/wt-ahead" commit -q -m ahead',
  ].join("\n");
  const got = await go(box, {
    case: {
      setup: [{ git: { init: true, commitAll: "initial" } }, { run: make }],
    },
    files: APP,
    agent: [
      agentRuns("git worktree list | wc -l"),
      agentRuns("git worktree list --porcelain | grep -c '^detached'"),
      agentRuns("git worktree list --porcelain | grep -c '^locked'"),
      agentRuns("git rev-list --count main..wt-ahead"),
      agentRuns(
        "for p in $(git worktree list --porcelain | sed -n 's/^worktree //p'); do git -C $p status --porcelain; done | wc -l",
      ),
    ],
  });
  expect(got.results?.invalid).toEqual([]);
  expect(printed(got.out).map((text) => text.trim())).toEqual([
    "5",
    "1",
    "1",
    "1",
    "1",
  ]);
});

test("setup commits carry a neutral identity, not one that names a fixture", async () => {
  const box = sandbox();
  const got = await go(box, {
    case: { setup: [{ git: { init: true, commitAll: "initial" } }] },
    files: APP,
    agent: [agentRuns("git log --format='%an|%ae|%cn|%ce'")],
  });
  expect(printed(got.out)[0]?.trim()).toBe(
    "Developer|developer@example.com|Developer|developer@example.com",
  );
});

test("a case env sets the git identity and dates for setup, and the agent sees them", async () => {
  const box = sandbox();
  const when = "2026-10-01T09:00:00Z";
  const got = await go(box, {
    case: {
      env: {
        GIT_AUTHOR_NAME: "Sam",
        GIT_AUTHOR_EMAIL: "sam@example.com",
        GIT_AUTHOR_DATE: when,
        GIT_COMMITTER_NAME: "Sam",
        GIT_COMMITTER_EMAIL: "sam@example.com",
        GIT_COMMITTER_DATE: when,
      },
      setup: [{ git: { init: true, commitAll: "initial" } }],
    },
    files: APP,
    agent: [
      agentRuns("git log --format='%an|%ae|%aI'"),
      agentRuns('echo "$GIT_AUTHOR_NAME"'),
    ],
  });
  expect(got.results?.invalid).toEqual([]);
  const [log, name] = printed(got.out);
  expect(log?.trim()).toBe("Sam|sam@example.com|2026-10-01T09:00:00+00:00");
  expect(name?.trim()).toBe("Sam");
});

test("setup does not read git configuration of the home or the operator", async () => {
  const box = sandbox();
  box.write(
    ".gitconfig",
    "[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = /bin/false\n",
  );
  const alias = "[alias]\n\tprobe = !echo leaked\n";
  const got = await go(box, {
    case: {
      setup: [
        { run: `printf '${alias}' > "$HOME/.gitconfig"` },
        { git: { init: true, commitAll: "initial" } },
        { run: "(git probe || echo none) > probe.txt 2>&1" },
      ],
    },
    files: APP,
    agent: [agentRuns("cat probe.txt")],
  });
  expect(got.results?.invalid).toEqual([]);
  expect(printed(got.out)[0]).toContain("none");
  expect(printed(got.out)[0]).not.toContain("leaked");
});

test("git never writes to the seed and never reaches a repository around the workspace", async () => {
  const box = sandbox();
  const got = await go(box, {
    case: {
      setup: [{ git: { init: true, commitAll: "initial" } }],
      checks: [
        {
          type: "command",
          run: 'test "$GIT_OPTIONAL_LOCKS" = 0 && test "$GIT_CEILING_DIRECTORIES" = "$(dirname "$SKILL_EVALS_WORKSPACE")"',
        },
        {
          type: "command",
          run: 'git -C "$SKILL_EVALS_SEED_DIR" status --porcelain',
          expectExit: 0,
          stdoutLacks: ".",
        },
      ],
    },
    files: APP,
  });
  expect(got.results?.records[0]?.checks.map((check) => check.score)).toEqual([
    1, 1,
  ]);
});

test("setup gets the same two git variables", async () => {
  const box = sandbox();
  const got = await go(box, {
    case: {
      setup: [{ run: "env > seen.txt" }],
      checks: [
        { type: "command", run: "grep -c '^GIT_OPTIONAL_LOCKS=0$' seen.txt" },
        {
          type: "command",
          run: 'grep -qx "GIT_CEILING_DIRECTORIES=$(dirname "$SKILL_EVALS_WORKSPACE")" seen.txt',
        },
      ],
    },
  });
  expect(got.results?.records[0]?.checks.map((check) => check.score)).toEqual([
    1, 1,
  ]);
});

test("a home file that would replace a file the harness placed makes the run invalid", async () => {
  const box = sandbox();
  const got = await go(box, {
    case: { home: "home" },
    files: { "home/.claude/skills/bro/SKILL.md": "mine\n" },
  });
  expect(got.results?.invalid[0]).toMatch(
    /home\/ would replace \.claude\/skills\/bro\/SKILL\.md/,
  );
  expect(fs.existsSync(box.started)).toBe(false);
  expect(path.basename(got.out)).toBe("results");
});

test("a failed step shows its command on one line, cut at 40 characters", async () => {
  const box = sandbox();
  const got = await go(box, {
    case: {
      setup: [
        { run: "echo   one\n\n  echo two\n  false # padding padding padding" },
      ],
    },
  });
  expect(got.results?.invalid[0]).toContain(
    "(echo one echo two false # padding paddin): ",
  );
});
