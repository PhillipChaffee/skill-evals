import fs from "node:fs";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { loadCases } from "./cases.js";
import { plantCase } from "./testing/plant.js";
import { dirsWith, scored as score } from "./testing/outcome.js";
import { sandbox } from "./testing/sandbox.js";

/**
 * Makes listing the directory called `locked` or `other` fail, as it does for a directory the agent locked.
 * @returns The spy, to restore when the test ends.
 */
function lock() {
  const list = fs.readdirSync.bind(fs);
  return vi.spyOn(fs, "readdirSync").mockImplementation(((
    dir: string,
    options: unknown,
  ) => {
    if (/\/(locked|other)$/.test(dir)) {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    }
    return (list as (...args: unknown[]) => unknown)(dir, options);
  }) as unknown as typeof fs.readdirSync);
}

/**
 * Runs an agent that adds a file under a directory and then locks it.
 * @param seed - The workspace before the run.
 * @param added - The file the agent creates, relative to the workspace.
 * @returns The outcome and the spy to restore.
 */
function lockedAfter(seed: Record<string, string>, added: string) {
  let spy: ReturnType<typeof lock> | undefined;
  const out = dirsWith(seed).run(({ workspace }) => {
    fs.mkdirSync(path.dirname(path.join(workspace, added)), {
      recursive: true,
    });
    fs.writeFileSync(path.join(workspace, added), "evil");
    spy = lock();
  });
  return { out, restore: () => spy?.mockRestore() };
}

const SEED = { "src/a.py": "a", "other/x.txt": "x", "locked/y.md": "y" };

test("file_unchanged cannot vouch for a glob that a directory it cannot list could hold", () => {
  const { out, restore } = lockedAfter(SEED, "other/evil.py");
  try {
    const empty = score({ type: "file_unchanged", path: "**/*.py" }, out);
    expect(empty.score).toBe(0);
    expect(empty.reason).toBe("locked, other cannot be listed");
    expect(empty.reason).not.toContain("deleted");
    for (const glob of ["other/*.py", "other", "other/", "*.py"]) {
      expect(
        score({ type: "file_unchanged", path: glob }, out).score,
        glob,
      ).toBe(0);
    }
    // A path on another branch of the tree is not in doubt.
    expect(score({ type: "file_unchanged", path: "src/*.py" }, out).score).toBe(
      1,
    );
    expect(score({ type: "file_unchanged", path: "src" }, out).score).toBe(1);
    expect(score({ type: "file_unchanged", path: "notes/**" }, out).score).toBe(
      1,
    );
  } finally {
    restore();
  }
});

test("a file added to a directory that was then locked defeats file_unchanged with a literal prefix", () => {
  const { out, restore } = lockedAfter(SEED, "locked/x.md");
  try {
    const verdict = score({ type: "file_unchanged", path: "locked/*.md" }, out);
    expect(verdict.score).toBe(0);
    expect(verdict.reason).toBe("locked cannot be listed");
  } finally {
    restore();
  }
});

test("an unlistable directory in the seed counts too, and files_changed_only needs it covered", () => {
  const spy = lock();
  try {
    const out = dirsWith(SEED).run();
    expect(score({ type: "file_unchanged", path: "other/**" }, out).score).toBe(
      0,
    );
    expect(score({ type: "file_changed", path: "other/**" }, out)).toEqual({
      score: 0,
      reason:
        'nothing matching "other/**" was created, modified or deleted; other cannot be listed',
    });
    const only = (allow: string[], ignore?: string[]) =>
      score(
        { type: "files_changed_only", allow, ...(ignore && { ignore }) },
        out,
      );
    expect(only(["src/**"]).reason).toBe("locked, other cannot be listed");
    expect(only(["src/**", "locked/**", "other"]).score).toBe(1);
    expect(only(["src/**"], ["locked", "other/"]).score).toBe(1);
    expect(only(["src/*.py"]).score).toBe(0);
  } finally {
    spy.mockRestore();
  }
});

test("file_count with a max and file_lines cannot be confirmed past an unlistable directory", () => {
  const spy = lock();
  try {
    const out = dirsWith(SEED).run();
    expect(
      score({ type: "file_count", path: "**/*.py", max: 5 }, out).score,
    ).toBe(0);
    expect(score({ type: "file_count", path: "**/*.py" }, out).score).toBe(1);
    const lines = score({ type: "file_lines", path: "**/*.py", max: 5 }, out);
    expect(lines.score).toBe(0);
    expect(lines.reason).toMatch(/^locked, other cannot be listed/);
    expect(score({ type: "file_lines", path: "src", max: 5 }, out).score).toBe(
      1,
    );
  } finally {
    spy.mockRestore();
  }
});

test("file_absent on a directory that was emptied scores 1; with a file left it scores 0", () => {
  const emptied = dirsWith({ "src/legacy/f.ts": "x", "src/keep.ts": "k" }).run(
    ({ workspace }) => {
      fs.rmSync(path.join(workspace, "src/legacy/f.ts"));
    },
  );
  for (const legacy of ["src/legacy", "src/legacy/"]) {
    expect(
      score({ type: "file_absent", path: legacy }, emptied).score,
      legacy,
    ).toBe(1);
    expect(
      score({ type: "dir_exists", path: "src/legacy" }, emptied).score,
    ).toBe(1);
  }
  expect(score({ type: "file_absent", path: "src" }, emptied).score).toBe(0);
  expect(score({ type: "file_absent", path: "src/*" }, emptied).score).toBe(0);
  const nested = dirsWith({}).run(({ workspace }) => {
    fs.mkdirSync(path.join(workspace, "a/b"), { recursive: true });
  });
  expect(score({ type: "file_absent", path: "a" }, nested).score).toBe(1);
});

test("a trailing slash keeps the 0.0.1 meaning for file_exists and file_matches", () => {
  const out = dirsWith({ "src/a.ts": "const a = 1;" }).run();
  for (const check of [
    { type: "file_exists", path: "src/" },
    { type: "file_matches", path: "src/", pattern: "const" },
    { type: "file_exists", path: "src/a.ts/" },
    { type: "file_matches", path: "src/a.ts/", pattern: "const" },
  ] as const) {
    expect(score(check, out).score, JSON.stringify(check)).toBe(0);
  }
  expect(score({ type: "file_exists", path: "src/a.ts" }, out).score).toBe(1);
});

test("a glob sees directories for file_absent and dir_exists, and counts files elsewhere", () => {
  const out = dirsWith({ "x.md/inner.txt": "t" }).run();
  expect(score({ type: "file_absent", path: "*.md" }, out).score).toBe(0);
  expect(score({ type: "dir_exists", path: "*.md" }, out).score).toBe(1);
  expect(
    score({ type: "file_count", path: "*.md", min: 0, max: 0 }, out).score,
  ).toBe(1);
});

test("a plain directory path that goes through a link inside the root is expanded from its real directory", () => {
  const out = dirsWith({ "src/a.ts": "x as any", "src/deep/b.ts": "fine" }).run(
    ({ workspace }) => {
      fs.symlinkSync("src", path.join(workspace, "alias"));
      fs.symlinkSync(".", path.join(workspace, "self"));
    },
  );
  const lacks = score(
    { type: "file_lacks", path: "alias", pattern: "as any" },
    out,
  );
  expect(lacks).toEqual({
    score: 0,
    reason: "files that match /as any/ or cannot be read: alias/a.ts",
  });
  expect(
    score({ type: "file_lacks", path: "alias/", pattern: "zzz" }, out).score,
  ).toBe(1);
  expect(
    score({ type: "file_count", path: "alias", min: 2, max: 2 }, out).score,
  ).toBe(1);
  expect(score({ type: "file_lines", path: "alias", max: 0 }, out).score).toBe(
    0,
  );
  expect(score({ type: "file_absent", path: "alias" }, out).score).toBe(0);
  expect(score({ type: "file_count", path: "self", min: 1 }, out).score).toBe(
    1,
  );
});

/**
 * Loads one planted check and returns the error message.
 * @param check - The check object, as a case file writes it.
 * @returns The message of the load error.
 */
function loadError(check: unknown): string {
  const box = sandbox();
  const cases = plantCase(box, [check]);
  try {
    loadCases(cases);
  } catch (error) {
    return (error as Error).message;
  }
  return "";
}

test("a path or glob that starts with ./ is a load error", () => {
  const hint = /drop the leading \.\/ from the path: \.\/notes.txt/;
  expect(loadError({ type: "file_exists", path: "./notes.txt" })).toMatch(hint);
  expect(loadError({ type: "file_absent", path: "./src/**" })).toMatch(
    /drop the leading/,
  );
  expect(
    loadError({ type: "files_changed_only", allow: ["./src/**"] }),
  ).toMatch(/"allow": drop the leading/);
  expect(loadError({ type: "file_exists", path: "notes.txt" })).toBe("");
});

test("an inputLinesMin above inputLinesMax is a load error, on a matcher and on a check", () => {
  const above = /"inputLinesMin" 5 is above "inputLinesMax" 3/;
  expect(
    loadError({
      type: "tool_called",
      kind: "write",
      inputLinesMin: 5,
      inputLinesMax: 3,
    }),
  ).toMatch(above);
  expect(
    loadError({
      type: "tool_not_called",
      kind: "write",
      inputLinesMin: 5,
      inputLinesMax: 3,
    }),
  ).toMatch(above);
  expect(
    loadError({
      type: "first_tool",
      matches: { kind: "write", inputLinesMin: 5, inputLinesMax: 3 },
    }),
  ).toMatch(above);
  expect(
    loadError({
      type: "tool_called",
      kind: "write",
      inputLinesMin: 3,
      inputLinesMax: 3,
    }),
  ).toBe("");
});

test("a link in a case's workspace that is absolute or leaves the workspace is a load error", () => {
  const box = sandbox();
  const cases = plantCase(box, [{ type: "file_exists", path: "notes.txt" }]);
  const workspace = path.join(box.root, "cases/restate/workspace");
  fs.symlinkSync("notes.txt", path.join(workspace, "fine.txt"));
  expect(loadCases(cases)).toHaveLength(1);
  fs.symlinkSync("../prompt.md", path.join(workspace, "up.md"));
  expect(() => loadCases(cases)).toThrow(
    /workspace\/up.md is a link to \.\.\/prompt.md; links outside the workspace are not allowed/,
  );
  fs.rmSync(path.join(workspace, "up.md"));
  fs.symlinkSync(path.join(box.root, "cases"), path.join(workspace, "abs"));
  expect(() => loadCases(cases)).toThrow(
    /workspace\/abs is a link to .*an absolute path/,
  );
});

test("many small files hash to the digest of their whole content", async () => {
  const { createHash } = await import("node:crypto");
  const { snapshot } = await import("./snapshot.js");
  const box = sandbox();
  const sizes = [0, 1, 7, 4096, 1_048_575, 1_048_576, 1_048_577];
  const want = new Map<string, string>();
  for (let n = 0; n < 200; n += 1) {
    const content = Buffer.alloc(sizes[n % sizes.length] ?? 0, String(n % 10));
    const name = `f/${String(n)}.bin`;
    fs.mkdirSync(path.join(box.root, "f"), { recursive: true });
    fs.writeFileSync(path.join(box.root, name), content);
    want.set(name.slice(2), createHash("sha256").update(content).digest("hex"));
  }
  const taken = snapshot(path.join(box.root, "f"));
  expect(taken.size).toBe(200);
  for (const [file, digest] of want) expect(taken.get(file), file).toBe(digest);
});
