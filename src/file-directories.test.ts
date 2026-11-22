import fs from "node:fs";
import path from "node:path";
import { expect, test, vi } from "vitest";
import type { Given } from "./testing/outcome.js";
import { dirsWith, scored as score } from "./testing/outcome.js";

const SEED = {
  "src/a.ts": "const a = 1;\n",
  "src/deep/b.ts": "const b = x as any;\n",
  "tests/t.py": "assert True\n",
  "notes.txt": "planted\n",
};

/**
 * Builds the run of the probe: the agent deletes `tests/t.py` and adds `tests/new.py`.
 * @returns The outcome.
 */
function swapped() {
  return dirsWith(SEED).run(({ workspace }) => {
    fs.rmSync(path.join(workspace, "tests/t.py"));
    fs.writeFileSync(path.join(workspace, "tests/new.py"), "");
  });
}

const TWO_WAYS = (dir: string): string[] => [dir, `${dir}/`];

test("a plain directory path covers its files in the change checks, with or without a slash", () => {
  const out = swapped();
  for (const tests of TWO_WAYS("tests")) {
    const label = JSON.stringify(tests);
    expect(
      score({ type: "file_unchanged", path: tests }, out).score,
      label,
    ).toBe(0);
    expect(score({ type: "file_changed", path: tests }, out).score, label).toBe(
      1,
    );
    expect(
      score({ type: "files_changed_only", allow: ["src", "notes.txt"] }, out)
        .score,
    ).toBe(0);
    expect(
      score({ type: "files_changed_only", allow: [tests] }, out).score,
      label,
    ).toBe(1);
    expect(
      score(
        { type: "files_changed_only", allow: ["src"], ignore: [tests] },
        out,
      ).score,
      label,
    ).toBe(1);
  }
  for (const src of TWO_WAYS("src")) {
    expect(score({ type: "file_unchanged", path: src }, out).score).toBe(1);
    expect(score({ type: "file_changed", path: src }, out).score).toBe(0);
  }
  expect(score({ type: "file_unchanged", path: "tests" }, out).reason).toBe(
    "changed: created tests/new.py, deleted tests/t.py",
  );
});

test("a directory that was deleted whole still covers its seeded files", () => {
  const out = dirsWith(SEED).run(({ workspace }) => {
    fs.rmSync(path.join(workspace, "tests"), { recursive: true });
  });
  expect(score({ type: "file_unchanged", path: "tests" }, out).score).toBe(0);
  expect(score({ type: "file_changed", path: "tests/" }, out).score).toBe(1);
  expect(score({ type: "file_absent", path: "tests" }, out).score).toBe(1);
});

test("file_lacks, file_count, file_lines and file_absent read a directory path as its files", () => {
  const out = dirsWith(SEED).run();
  for (const src of TWO_WAYS("src")) {
    const lacks: Given = { type: "file_lacks", path: src, pattern: "as any" };
    expect(score(lacks, out)).toEqual({
      score: 0,
      reason: "files that match /as any/ or cannot be read: src/deep/b.ts",
    });
    expect(score({ ...lacks, pattern: "zzz" }, out).score).toBe(1);
    expect(
      score({ type: "file_count", path: src, min: 2, max: 2 }, out).score,
    ).toBe(1);
    expect(score({ type: "file_count", path: src, min: 3 }, out).score).toBe(0);
    expect(score({ type: "file_lines", path: src, max: 1 }, out).score).toBe(1);
    expect(score({ type: "file_lines", path: src, max: 0 }, out).score).toBe(0);
    expect(score({ type: "file_absent", path: src }, out).score).toBe(0);
  }
  expect(
    score({ type: "file_count", path: "notes.txt/", min: 0, max: 0 }, out)
      .score,
  ).toBe(1);
});

test("file_exists, file_matches and dir_exists keep reading a plain path as one entry", () => {
  const out = dirsWith(SEED).run();
  expect(score({ type: "file_exists", path: "src" }, out).score).toBe(0);
  expect(
    score({ type: "file_matches", path: "src", pattern: "const" }, out).score,
  ).toBe(0);
  expect(score({ type: "dir_exists", path: "src" }, out).score).toBe(1);
});

test("a glob counts files only, and a directory it matches is not expanded", () => {
  const out = dirsWith({ "x.md/inner.txt": "t", "y.md": "t" }).run();
  expect(
    score({ type: "file_count", path: "*.md", min: 1, max: 1 }, out).score,
  ).toBe(1);
  expect(
    score({ type: "file_lacks", path: "*.md", pattern: "t" }, out).score,
  ).toBe(0);
  expect(
    score(
      { type: "file_lacks", path: "*.md", pattern: "t", quantifier: "any" },
      out,
    ).score,
  ).toBe(0);
  expect(score({ type: "file_unchanged", path: "*.md" }, out).score).toBe(1);
});

/**
 * Makes listing a directory fail, as it does for a directory the agent made unreadable.
 * @param name - The last part of the directory's path.
 * @returns The spy, which the test ends by restoring.
 */
function unlistable(name: string) {
  const list = fs.readdirSync.bind(fs);
  return vi.spyOn(fs, "readdirSync").mockImplementation(((
    dir: string,
    options: unknown,
  ) => {
    if (dir.endsWith(`/${name}`)) {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    }
    return (list as (...args: unknown[]) => unknown)(dir, options);
  }) as unknown as typeof fs.readdirSync);
}

const LOCKED_MD = "locked/*.md";
const SECRET = "secret/x.ts";
const LOCKED_SEED = { "locked/a.ts": "x as any", "src/ok.ts": "fine" };

test("an unreadable directory makes file_lacks, file_absent and file_unchanged score 0, naming it", () => {
  const spy = unlistable("locked");
  try {
    const out = dirsWith(LOCKED_SEED).run();
    const named = /locked cannot be listed/;
    for (const check of [
      { type: "file_lacks", path: "locked", pattern: "zzz" },
      { type: "file_lacks", path: "**/*.ts", pattern: "zzz" },
      { type: "file_lacks", path: "locked/**", pattern: "zzz" },
      { type: "file_absent", path: "locked/**" },
      { type: "file_absent", path: "**/b.ts" },
    ] as const) {
      const verdict = score(check, out);
      expect(verdict.score, JSON.stringify(check)).toBe(0);
      expect(verdict.reason, JSON.stringify(check)).toMatch(named);
    }
    expect(
      score({ type: "file_lacks", path: "src", pattern: "zzz" }, out).score,
    ).toBe(1);
    expect(score({ type: "file_absent", path: "src/gone.ts" }, out).score).toBe(
      1,
    );
  } finally {
    spy.mockRestore();
  }
});

test("a directory that became unreadable during the run is a change, so file_unchanged scores 0", () => {
  const dirs = dirsWith(LOCKED_SEED);
  let spy: ReturnType<typeof unlistable> | undefined;
  const out = dirs.run(() => {
    spy = unlistable("locked");
  });
  try {
    for (const path of ["locked", "locked/**", "locked/a.ts"]) {
      const verdict = score({ type: "file_unchanged", path }, out);
      expect(verdict.score, path).toBe(0);
      expect(verdict.reason, path).toContain("locked");
    }
  } finally {
    spy?.mockRestore();
  }
});

test("other checks name an unreadable directory in their reason", () => {
  const spy = unlistable("locked");
  try {
    const out = dirsWith(LOCKED_SEED).run();
    for (const check of [
      { type: "file_exists", path: LOCKED_MD },
      { type: "file_count", path: LOCKED_MD },
      { type: "dir_exists", path: "locked/*/" },
      { type: "file_matches", path: LOCKED_MD, pattern: "x" },
      { type: "file_lines", path: LOCKED_MD, min: 1 },
    ] as const) {
      expect(score(check, out).reason, check.type).toMatch(
        /locked cannot be listed/,
      );
    }
  } finally {
    spy.mockRestore();
  }
});

test("a path whose lookup fails for a reason other than absence fails closed; a missing one is absent", () => {
  const dirs = dirsWith({ [SECRET]: "x", "src/a.ts": "a" });
  const out = dirs.run();
  const real = fs.realpathSync.native;
  const spy = vi.spyOn(fs.realpathSync, "native").mockImplementation(((
    file: fs.PathLike,
    ...rest: unknown[]
  ) => {
    if (String(file).endsWith(SECRET)) {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    }
    return (real as (...args: unknown[]) => unknown)(file, ...rest);
  }) as typeof fs.realpathSync.native);
  try {
    const absent = score({ type: "file_absent", path: SECRET }, out);
    expect(absent.score).toBe(0);
    expect(absent.reason).toBe(
      "cannot be shown absent; secret/x.ts cannot be listed",
    );
    expect(
      score({ type: "file_lacks", path: SECRET, pattern: "z" }, out).score,
    ).toBe(0);
    expect(score({ type: "file_absent", path: "src/none.ts" }, out).score).toBe(
      1,
    );
  } finally {
    spy.mockRestore();
  }
});

test("a root that cannot be looked up for another reason than absence fails closed", () => {
  const dirs = dirsWith({ "a.ts": "a" });
  const out = dirs.run();
  const real = fs.realpathSync.native;
  const spy = vi.spyOn(fs.realpathSync, "native").mockImplementation(((
    file: fs.PathLike,
    ...rest: unknown[]
  ) => {
    if (String(file) === dirs.workspace) {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    }
    return (real as (...args: unknown[]) => unknown)(file, ...rest);
  }) as typeof fs.realpathSync.native);
  try {
    expect(score({ type: "file_absent", path: "a.ts" }, out).reason).toBe(
      "cannot be shown absent; . cannot be listed",
    );
    expect(
      score({ type: "file_lacks", path: "**", pattern: "z" }, out).score,
    ).toBe(0);
  } finally {
    spy.mockRestore();
  }
});

test("file_exists scores 0 for a file that exists and cannot be read", () => {
  const out = dirsWith({ "a.txt": "x", "b.txt": "y" }).run();
  const open = fs.openSync.bind(fs);
  const spy = vi.spyOn(fs, "openSync").mockImplementation(((
    file: string,
    flags: string,
  ) => {
    if (file.endsWith("b.txt")) throw new Error("EACCES");
    return open(file, flags);
  }) as typeof fs.openSync);
  try {
    expect(score({ type: "file_exists", path: "b.txt" }, out)).toEqual({
      score: 0,
      reason: "b.txt exists but cannot be read",
    });
    expect(score({ type: "file_exists", path: "*.txt" }, out).score).toBe(1);
  } finally {
    spy.mockRestore();
  }
});
