import fs from "node:fs";
import { expect, test } from "vitest";
import { exec, play, scoreSubject, writeCase } from "./testing/runs.js";
import { sandbox } from "./testing/sandbox.js";

const NOTES = "notes.txt";
const PARSE = "src/parse.py";
const RESEARCH = "docs/research/*.md";
const SEED: Record<string, string> = {
  [PARSE]: "def parse():\n    return 1\n",
  "src/legacy/formatPrice.ts": "export const f = 1;\n",
  "src/other.ts": "export const g = x as any;\n",
  "tests/test_parse.py": "assert True\n",
  [NOTES]: "planted\n",
};

/**
 * Plants one case with a seeded workspace and a scripted agent, and runs it.
 * @param id - The case id.
 * @param checks - The checks of the case.
 * @param steps - Shell commands the agent runs in its workspace.
 * @returns The record of the run.
 */
async function ran(id: string, checks: unknown[], steps: string[]) {
  const box = sandbox();
  writeCase(box, "cases", { id, checks });
  for (const [file, text] of Object.entries(SEED)) {
    box.write(`cases/${id}/workspace/${file}`, text);
  }
  play(box, { name: id, id, steps: steps.map(exec) });
  const done = await scoreSubject(box, {
    subject: "none",
    cases: `${box.root}/cases`,
  });
  expect(done.status, done.stderr).toBe(0);
  const [record] = done.records;
  if (!record) throw new Error("the run left no record");
  return record;
}

const AGENT = [
  "mkdir -p docs/research && echo '# findings' > docs/research/a.md",
  "echo '# edit' >> src/parse.py",
  "rm src/legacy/formatPrice.ts",
];

// Each check, in a form that passes and in a form that fails, against the one scripted run.
const TABLE: [string, Record<string, unknown>, number][] = [
  [
    "file_exists passes",
    { type: "file_exists", path: "docs/research/a.md" },
    1,
  ],
  [
    "file_exists created passes",
    { type: "file_exists", path: RESEARCH, created: true },
    1,
  ],
  [
    "file_exists created fails for a seeded file",
    { type: "file_exists", path: PARSE, created: true },
    0,
  ],
  ["file_exists fails", { type: "file_exists", path: "docs/research/b.md" }, 0],
  [
    "file_absent passes",
    { type: "file_absent", path: "src/legacy/formatPrice.ts" },
    1,
  ],
  ["file_absent fails", { type: "file_absent", path: PARSE }, 0],
  [
    "file_lacks passes",
    { type: "file_lacks", path: PARSE, pattern: "as any" },
    1,
  ],
  [
    "file_lacks fails",
    { type: "file_lacks", path: "src/**/*.ts", pattern: "\\bas any\\b" },
    0,
  ],
  ["file_unchanged passes", { type: "file_unchanged", path: "tests/**" }, 1],
  ["file_unchanged fails", { type: "file_unchanged", path: "src/**" }, 0],
  [
    "file_unchanged fails for a deleted file",
    { type: "file_unchanged", path: "src/legacy/*" },
    0,
  ],
  ["file_changed passes", { type: "file_changed", path: PARSE }, 1],
  ["file_changed fails", { type: "file_changed", path: NOTES }, 0],
  [
    "files_changed_only passes",
    { type: "files_changed_only", allow: ["src/**", "docs/**"] },
    1,
  ],
  [
    "files_changed_only fails",
    { type: "files_changed_only", allow: ["src/**"] },
    0,
  ],
  [
    "files_changed_only ignore",
    { type: "files_changed_only", allow: ["src/**"], ignore: ["docs/**"] },
    1,
  ],
  [
    "file_count passes",
    { type: "file_count", path: RESEARCH, min: 1, max: 1 },
    1,
  ],
  ["file_count fails", { type: "file_count", path: RESEARCH, min: 2 }, 0],
  ["dir_exists passes", { type: "dir_exists", path: "docs/research" }, 1],
  ["dir_exists fails for a file", { type: "dir_exists", path: PARSE }, 0],
  ["file_lines passes", { type: "file_lines", path: PARSE, min: 3, max: 3 }, 1],
  ["file_lines fails", { type: "file_lines", path: PARSE, max: 2 }, 0],
];

test("each file-state check scores a scripted run both ways", async () => {
  const record = await ran(
    "table",
    TABLE.map(([, check]) => check),
    AGENT,
  );
  expect(record.score).not.toBeNull();
  expect(record.checks.map((check) => check.score)).toEqual(
    TABLE.map(([, , expected]) => expected),
  );
  // Every failure says which paths it is about.
  const [, , , failed] = record.checks;
  expect(failed?.reason).toContain("docs/research/b.md");
  expect(record.checks[5]?.reason).toContain(PARSE);
});

test("changedFiles lists created, modified and deleted", async () => {
  const record = await ran(
    "changed",
    [{ type: "output_contains", text: "done" }],
    AGENT,
  );
  expect(record.changedFiles).toEqual({
    created: ["docs/research/a.md"],
    modified: [PARSE],
    deleted: ["src/legacy/formatPrice.ts"],
  });
});

test("root home reads the throwaway home", async () => {
  const record = await ran(
    "home",
    [
      { type: "file_exists", path: ".audit/log.txt", root: "home" },
      { type: "file_exists", path: ".audit/log.txt" },
      { type: "file_changed", path: ".audit/*", root: "home" },
      { type: "file_unchanged", path: NOTES, root: "home" },
    ],
    ['mkdir -p "$HOME/.audit" && echo hi > "$HOME/.audit/log.txt"'],
  );
  expect(record.checks.map((check) => check.score)).toEqual([1, 0, 1, 1]);
  expect(record.changedFiles.created).toEqual([]);
});

test("a glob never follows a link out of the workspace", async () => {
  const record = await ran(
    "link",
    [
      { type: "file_exists", path: "etc/passwd" },
      { type: "file_exists", path: "etc/*" },
      { type: "file_absent", path: "etc/passwd" },
      { type: "file_lacks", path: "etc/**", pattern: "root" },
    ],
    ["ln -s /etc etc"],
  );
  expect(record.checks.map((check) => check.score)).toEqual([0, 0, 1, 1]);
});

test("the agent deleting the whole workspace still yields a record", async () => {
  const record = await ran(
    "wreck",
    [
      { type: "file_exists", path: NOTES },
      { type: "file_matches", path: "src/**", pattern: "x" },
      { type: "file_lacks", path: "src/**", pattern: "x" },
      { type: "file_absent", path: PARSE },
      { type: "file_unchanged", path: "tests/**" },
      { type: "file_changed", path: NOTES },
      { type: "files_changed_only", allow: ["docs/**"] },
      { type: "file_count", path: "src/**" },
      { type: "dir_exists", path: "src" },
      { type: "file_lines", path: NOTES, max: 9 },
    ],
    ['cd .. && rm -rf "$OLDPWD"'],
  );
  expect(record.score).not.toBeNull();
  expect(record.checks.map((check) => check.score)).toEqual([
    0, 0, 1, 1, 0, 1, 0, 0, 0, 0,
  ]);
  expect(record.changedFiles.deleted).toContain("notes.txt");
});

test("ten thousand matches hit the cap with the glob named", async () => {
  const record = await ran(
    "many",
    [
      { type: "file_count", path: "many/*.txt", min: 0 },
      { type: "file_exists", path: NOTES },
    ],
    ["mkdir many && cd many && seq 1 10000 | sed 's/$/.txt/' | xargs touch"],
  );
  expect(record.ok).toBe(true);
  expect(record.score).not.toBeNull();
  const [capped, fine] = record.checks;
  expect(capped?.score).toBe(0);
  expect(capped?.reason).toMatch(/"many\/\*\.txt".*5000.*cap/);
  expect(fine?.score).toBe(1);
});

test("a 0.0.1 file_exists or file_matches with a plain path scores as before", async () => {
  const record = await ran(
    "plain",
    [
      { type: "file_exists", path: NOTES },
      { type: "file_exists", path: "missing.txt" },
      { type: "file_exists", path: "src" },
      {
        type: "file_matches",
        path: NOTES,
        pattern: "^PLANTED$",
        flags: "im",
      },
      { type: "file_matches", path: NOTES, pattern: "nope" },
      { type: "file_matches", path: "missing.txt", pattern: "x" },
      { type: "file_exists", path: "notes.*" },
    ],
    [],
  );
  expect(record.checks.map((check) => check.score)).toEqual([
    1, 0, 0, 1, 0, 0, 1,
  ]);
});

test("a changed seed does not leak between two reps", async () => {
  const box = sandbox();
  writeCase(box, "cases", {
    id: "reps",
    checks: [{ type: "file_changed", path: NOTES }],
  });
  box.write("cases/reps/workspace/notes.txt", "planted\n");
  play(box, {
    name: "reps",
    id: "reps",
    steps: [exec("echo more >> notes.txt")],
  });
  const done = await scoreSubject(box, {
    subject: "none",
    cases: `${box.root}/cases`,
    reps: 2,
  });
  expect(done.records.map((record) => record.checks[0]?.score)).toEqual([1, 1]);
});

test("a relative link in the workspace fixture stays inside the workspace and scores as in 0.0.1", async () => {
  const box = sandbox();
  writeCase(box, "cases", {
    id: "links",
    checks: [
      { type: "file_exists", path: "alias.md" },
      { type: "file_matches", path: "alias.md", pattern: "^fixture$" },
      { type: "file_exists", path: "docs/alias/in.md" },
    ],
  });
  box.write("cases/links/workspace/real.md", "fixture");
  box.write("cases/links/workspace/docs/real/in.md", "inner");
  const fixture = `${box.root}/cases/links/workspace`;
  fs.symlinkSync("real.md", `${fixture}/alias.md`);
  fs.symlinkSync("real", `${fixture}/docs/alias`);
  play(box, {
    name: "links",
    id: "links",
    steps: [exec("echo changed >> alias.md")],
  });
  const done = await scoreSubject(box, {
    subject: "none",
    cases: `${box.root}/cases`,
  });
  expect(done.status, done.stderr).toBe(0);
  const [record] = done.records;
  expect(record?.checks.map((check) => check.score)).toEqual([1, 0, 1]);
  // The write went through the link inside the copy and never reached the fixture.
  expect(fs.readFileSync(`${fixture}/real.md`, "utf8")).toBe("fixture");
  expect(record?.changedFiles.modified).toContain("real.md");
});
