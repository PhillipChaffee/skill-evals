import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, test } from "vitest";
import { EXIT } from "./exit-codes.js";
import { script } from "./testing/plant.js";
import {
  KEEP,
  REJUDGED,
  onlyRecord,
  plantGrader,
  read,
  scoredWith,
} from "./testing/rejudge.js";
import { exec } from "./testing/runs.js";
import { sandbox } from "./testing/sandbox.js";

const PLAIN_WORDS = { prompt: "plain words" };
const LOGIN = ".claude/.credentials.json";
const OUTSIDE = "outside/.claude/.credentials.json";
const SECRET = "secret-token-0123456789-abcdefghijklmnop";
const EXISTS = { type: "file_exists", path: "notes.txt" };

/**
 * Lists the names and the content of an archive.
 * @param archive - The archive's path.
 * @returns The entry names, and all the content joined.
 */
function inside(archive: string): { names: string[]; content: string } {
  return {
    names: execFileSync("tar", ["-tf", archive], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean),
    content: execFileSync("tar", ["-xOf", archive], {
      encoding: "utf8",
      maxBuffer: 1 << 26,
    }),
  };
}

/**
 * Plants a login, a login outside the home, and an agent that replaces the home's `.claude` with a link to it.
 * @param box - The sandbox.
 */
function linkLogin(box: ReturnType<typeof sandbox>): void {
  box.write(LOGIN, SECRET);
  box.write(OUTSIDE, OUTSIDE_LOGIN);
  script(box, "link", {
    match: PLAIN_WORDS,
    turns: [
      [
        exec(
          `rm -rf "$HOME/.claude" && ln -s "${box.root}/outside/.claude" "$HOME/.claude"`,
        ),
        { final: "done" },
      ],
    ],
  });
}

const OUTSIDE_LOGIN = "outside-login";

test("a login behind a link in the home is never followed into the archive's removal", async () => {
  const scored = await scoredWith([EXISTS], {
    flags: [KEEP],
    plant: linkLogin,
  });
  expect(read(path.join(scored.box.root, OUTSIDE))).toBe(OUTSIDE_LOGIN);
  const record = onlyRecord(scored.out);
  const { content } = inside(
    path.join(scored.out, record.workspaceArchive?.path ?? ""),
  );
  expect(content).not.toContain(SECRET);
  expect(content).not.toContain(OUTSIDE_LOGIN);
});

test("a login behind a link in the home is never followed into the removal before commands", async () => {
  const scored = await scoredWith([{ type: "command", run: "true" }], {
    plant: linkLogin,
  });
  expect(read(path.join(scored.box.root, OUTSIDE))).toBe(OUTSIDE_LOGIN);
  expect(onlyRecord(scored.out).checks[0]?.score).toBe(1);
});

test("a copy of the login elsewhere in the home or the workspace is left out of the archive", async () => {
  const scored = await scoredWith([EXISTS], {
    flags: [KEEP],
    plant: (box) => {
      box.write(LOGIN, SECRET);
      script(box, "copy", {
        match: PLAIN_WORDS,
        turns: [
          [
            exec(
              `cp "$HOME/${LOGIN}" "$HOME/copy.json" && cp "$HOME/${LOGIN}" stolen.txt`,
            ),
            { final: "done" },
          ],
        ],
      });
    },
  });
  const record = onlyRecord(scored.out);
  const { names, content } = inside(
    path.join(scored.out, record.workspaceArchive?.path ?? ""),
  );
  expect(content).not.toContain(SECRET);
  expect(names).not.toContain("home/copy.json");
  expect(names).not.toContain("workspace/stolen.txt");
  expect(names).toContain("workspace/notes.txt");
  expect(record.workspaceArchive?.omitted?.sort()).toEqual([
    "home/copy.json",
    "workspace/stolen.txt",
  ]);
  const ran = await scored.rejudge();
  expect(
    ran.stderr.match(/the archive omitted 2 files matching login/g),
  ).toHaveLength(1);
});

test("an empty or generic file survives when the login is empty or short", async () => {
  const scored = await scoredWith([EXISTS], {
    flags: [KEEP],
    plant: (box) => {
      box.write(LOGIN, "");
      box.write("cases/restate/workspace/pkg/__init__.py", "");
      box.write("cases/restate/workspace/tsconfig.json", "{}");
    },
  });
  const record = onlyRecord(scored.out);
  const { names } = inside(
    path.join(scored.out, record.workspaceArchive?.path ?? ""),
  );
  for (const kept of [
    "workspace/pkg/__init__.py",
    "workspace/tsconfig.json",
    "seed/pkg/__init__.py",
  ]) {
    expect(names).toContain(kept);
  }
  expect(record.workspaceArchive?.omitted).toEqual([]);
});

test("what a command check writes, such as a copy of the grader, is not in the archive", async () => {
  const leak = {
    type: "command",
    run: `node -e 'require("fs").copyFileSync(process.env.SKILL_EVALS_GRADER_DIR + "/ok.txt", "leak.txt")'`,
  };
  const scored = await scoredWith([leak], {
    flags: [KEEP],
    plant: (box) => {
      box.write("cases/restate/grader/ok.txt", "held out\n");
    },
  });
  plantGrader(scored);
  const record = onlyRecord(scored.out);
  const { names, content } = inside(
    path.join(scored.out, record.workspaceArchive?.path ?? ""),
  );
  expect(record.checks[0]?.score).toBe(1);
  expect(names).not.toContain("workspace/leak.txt");
  expect(content).not.toContain("held out");
});

test("commands that change the workspace score the same when the run is scored again", async () => {
  const checks = [
    { type: "file_absent", path: "built.txt" },
    { type: "command", run: ": > built.txt" },
    { type: "command", run: "test ! -f built2.txt && : > built2.txt" },
  ];
  const scored = await scoredWith(checks, { flags: [KEEP] });
  const first = onlyRecord(scored.out).checks.map((check) => check.score);
  expect(first).toEqual([1, 1, 1]);
  const ran = await scored.rejudge();
  expect(ran.status, ran.stderr).toBe(EXIT.ok);
  expect(onlyRecord(scored.out, REJUDGED).checks.map((c) => c.score)).toEqual(
    first,
  );
});
