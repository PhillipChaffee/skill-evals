import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import type { Given } from "./testing/outcome.js";
import { dirsWith, scored as score } from "./testing/outcome.js";

const SEED = {
  "src/a.ts": "const a = 1;\n",
  "src/b.ts": "const b = x as any;\n",
  "tests/t.py": "assert True\n",
  "notes.txt": "planted\n",
};

test("a glob matches files, never directories, and a literal path is a file", () => {
  const out = dirsWith(SEED).run();
  expect(score({ type: "file_exists", path: "src" }, out).score).toBe(0);
  expect(score({ type: "file_exists", path: "src/*.ts" }, out).score).toBe(1);
  expect(score({ type: "file_exists", path: "src/{a,z}.ts" }, out).score).toBe(
    1,
  );
  expect(score({ type: "file_exists", path: "src/?.ts" }, out).score).toBe(1);
  expect(score({ type: "file_exists", path: "./notes.txt" }, out).score).toBe(
    1,
  );
  expect(score({ type: "file_exists", path: "src/*.py" }, out)).toEqual({
    score: 0,
    reason: 'no file matches "src/*.py" in the workspace',
  });
});

test("file_exists with created needs a file that the seed lacked", () => {
  const dirs = dirsWith(SEED);
  const out = dirs.run(({ workspace }) => {
    fs.writeFileSync(path.join(workspace, "new.md"), "x");
    fs.writeFileSync(path.join(workspace, "notes.txt"), "edited");
  });
  const created = (glob: string) =>
    score({ type: "file_exists", path: glob, created: true }, out);
  expect(created("new.md").score).toBe(1);
  expect(created("*.md").score).toBe(1);
  const old = created("notes.txt");
  expect(old.score).toBe(0);
  expect(old.reason).toMatch(/notes.txt was in the seed/);
  expect(created("missing.md").score).toBe(0);
});

test("file_matches defaults to any file and file_lacks to every file", () => {
  const out = dirsWith(SEED).run();
  const check = { path: "src/*.ts", pattern: "as any" };
  expect(score({ type: "file_matches", ...check }, out).score).toBe(1);
  expect(
    score({ type: "file_matches", ...check, quantifier: "all" }, out),
  ).toEqual({
    score: 0,
    reason: "not every file matches /as any/: src/a.ts",
  });
  const lacks = score({ type: "file_lacks", ...check }, out);
  expect(lacks).toEqual({
    score: 0,
    reason: "files that match /as any/ or cannot be read: src/b.ts",
  });
  expect(
    score({ type: "file_lacks", ...check, quantifier: "any" }, out).score,
  ).toBe(1);
  const all = { ...check, path: "tests/*" };
  expect(score({ type: "file_lacks", ...all }, out).score).toBe(1);
  expect(
    score({ type: "file_matches", ...all, flags: "i", pattern: "TRUE" }, out)
      .score,
  ).toBe(1);
});

test("a glob that matches no file: matches, exists, changed and lines score 0; lacks and absent score 1", () => {
  const out = dirsWith(SEED).run();
  const path = "nothing/**/*.ts";
  const zero: Given[] = [
    { type: "file_matches", path, pattern: "x" },
    { type: "file_exists", path },
    { type: "file_changed", path },
    { type: "file_lines", path, min: 1 },
    { type: "dir_exists", path },
    { type: "file_count", path },
  ];
  for (const check of zero) expect(score(check, out).score, check.type).toBe(0);
  const one: Given[] = [
    { type: "file_lacks", path, pattern: "x" },
    { type: "file_absent", path },
    { type: "file_unchanged", path },
    { type: "files_changed_only", allow: ["src/**"] },
    { type: "file_count", path, min: 0, max: 0 },
  ];
  for (const check of one) expect(score(check, out).score, check.type).toBe(1);
});

test("file_absent names what is still there", () => {
  const out = dirsWith(SEED).run();
  expect(score({ type: "file_absent", path: "src/b.ts" }, out)).toEqual({
    score: 0,
    reason: 'present: src/b.ts matches "src/b.ts"',
  });
  expect(score({ type: "file_absent", path: "src" }, out).score).toBe(0);
  expect(score({ type: "file_absent", path: "src/gone.ts" }, out).score).toBe(
    1,
  );
});

test("file_unchanged and file_changed read the seed", () => {
  const out = dirsWith(SEED).run(({ workspace }) => {
    fs.appendFileSync(path.join(workspace, "src/a.ts"), "// edit\n");
    fs.rmSync(path.join(workspace, "src/b.ts"));
    fs.writeFileSync(path.join(workspace, "src/c.ts"), "");
  });
  expect(score({ type: "file_unchanged", path: "tests/**" }, out).score).toBe(
    1,
  );
  const edited = score({ type: "file_unchanged", path: "src/*.ts" }, out);
  expect(edited).toEqual({
    score: 0,
    reason: "changed: created src/c.ts, modified src/a.ts, deleted src/b.ts",
  });
  expect(score({ type: "file_unchanged", path: "src/b.ts" }, out).score).toBe(
    0,
  );
  expect(score({ type: "file_changed", path: "src/a.ts" }, out).score).toBe(1);
  expect(score({ type: "file_changed", path: "src/c.ts" }, out).score).toBe(1);
  expect(score({ type: "file_changed", path: "src/b.ts" }, out).score).toBe(1);
  const same = score({ type: "file_changed", path: "tests/*" }, out);
  expect(same.score).toBe(0);
  expect(same.reason).toBe(
    'nothing matching "tests/*" was created, modified or deleted',
  );
});

test("files_changed_only lists what is outside allow, after ignore", () => {
  const out = dirsWith(SEED).run(({ workspace }) => {
    fs.appendFileSync(path.join(workspace, "src/a.ts"), "// edit\n");
    fs.writeFileSync(path.join(workspace, "debug.log"), "");
    fs.writeFileSync(path.join(workspace, "tests/new.py"), "");
  });
  const only = (allow: string[], ignore?: string[]) =>
    score(
      {
        type: "files_changed_only",
        allow,
        ...(ignore && { ignore }),
      },
      out,
    );
  expect(only(["src/**"])).toEqual({
    score: 0,
    reason: "changed outside allow: created debug.log, created tests/new.py",
  });
  expect(only(["src/**"], ["*.log", "tests/**"]).score).toBe(1);
  expect(only(["**"]).score).toBe(1);
});

test("file_count counts files, with min 1 by default", () => {
  const out = dirsWith(SEED).run();
  const count = (more: Partial<Given>) =>
    score({ type: "file_count", path: "src/*", ...more }, out);
  expect(count({}).score).toBe(1);
  expect(count({ min: 3 })).toEqual({
    score: 0,
    reason: '2 files match "src/*", fewer than min 3: src/a.ts, src/b.ts',
  });
  expect(count({ max: 1 }).reason).toMatch(/more than max 1/);
  expect(
    score({ type: "file_count", path: "src", min: 2, max: 2 }, out).score,
  ).toBe(1);
  expect(
    score({ type: "file_count", path: "src/*", min: 2, max: 2 }, out).score,
  ).toBe(1);
});

test("dir_exists matches directories only", () => {
  const out = dirsWith(SEED).run();
  expect(score({ type: "dir_exists", path: "src" }, out).score).toBe(1);
  expect(score({ type: "dir_exists", path: "s*" }, out).score).toBe(1);
  expect(score({ type: "dir_exists", path: "notes.txt" }, out)).toEqual({
    score: 0,
    reason: 'no directory matches "notes.txt" in the workspace',
  });
});

test("file_lines bounds the line count of every matched file", () => {
  const out = dirsWith({
    "one.txt": "a\n",
    "three.txt": "a\nb\nc",
    "empty.txt": "",
  }).run();
  const lines = (glob: string, more: Partial<Given>) =>
    score({ type: "file_lines", path: glob, ...more }, out);
  expect(lines("three.txt", { min: 3, max: 3 }).score).toBe(1);
  expect(lines("one.txt", { max: 1 }).score).toBe(1);
  expect(lines("empty.txt", { max: 0 }).score).toBe(1);
  expect(lines("*.txt", { max: 3 }).score).toBe(1);
  expect(lines("*.txt", { min: 1 })).toEqual({
    score: 0,
    reason: "files outside the line bounds: empty.txt (0 lines)",
  });
  expect(lines("*.txt", { max: 2 }).reason).toMatch(/three.txt \(3 lines\)/);
});

test("a reason names ten paths, then counts the rest", () => {
  const seed = Object.fromEntries(
    Array.from({ length: 13 }, (_, n) => [
      `f/${String(n).padStart(2, "0")}.ts`,
      "x as any",
    ]),
  );
  const out = dirsWith(seed).run();
  const verdict = score(
    { type: "file_lacks", path: "f/*.ts", pattern: "as any" },
    out,
  );
  expect(verdict.reason).toContain("f/09.ts and 3 more");
  expect(verdict.reason).not.toContain("f/10.ts");
});
