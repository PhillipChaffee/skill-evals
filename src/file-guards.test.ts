import fs from "node:fs";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { describeCheck } from "./checks/index.js";
import type { Given } from "./testing/outcome.js";
import { dirsWith, scored as score } from "./testing/outcome.js";

const LOG = ".audit/log.txt";
const MANY = "many/*.txt";
const SEED = {
  "src/a.ts": "const a = 1;\n",
  "src/b.ts": "const b = x as any;\n",
  "tests/t.py": "assert True\n",
  "notes.txt": "planted\n",
};

test("a file over 5 MB scores 0 for a pattern check, and is named", () => {
  const dirs = dirsWith({ "small.txt": "needle" });
  dirs.put("big.txt", Buffer.alloc(5 * 1024 * 1024 + 1, "a"));
  const out = dirs.run();
  const check = { path: "*.txt", pattern: "needle" };
  expect(
    score({ type: "file_matches", ...check, quantifier: "all" }, out),
  ).toEqual({
    score: 0,
    reason:
      "not every file matches /needle/: big.txt (file is larger than the 5 MB pattern cap)",
  });
  expect(score({ type: "file_matches", ...check }, out).score).toBe(1);
  const lacks = score({ type: "file_lacks", ...check, pattern: "zzz" }, out);
  expect(lacks.score).toBe(0);
  expect(lacks.reason).toContain(
    "big.txt (file is larger than the 5 MB pattern cap)",
  );
  expect(
    score({ type: "file_matches", path: "big.txt", pattern: "a" }, out).reason,
  ).toContain("file is larger than the 5 MB pattern cap");
  expect(
    score({ type: "file_lines", path: "big.txt", min: 0 }, out).score,
  ).toBe(0);
});

test("a file is decoded as UTF-8 with replacement characters", () => {
  const dirs = dirsWith();
  dirs.put("bin.txt", Buffer.from([0x61, 0xff, 0xfe, 0x62]));
  const out = dirs.run();
  expect(
    score({ type: "file_matches", path: "bin.txt", pattern: "a\\uFFFD+b" }, out)
      .score,
  ).toBe(1);
});

test("an unreadable file does not match, is named, and never throws", () => {
  const dirs = dirsWith({ "a.txt": "needle", "b.txt": "needle" });
  const out = dirs.run();
  const real = fs.readFileSync;
  const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((
    file: fs.PathOrFileDescriptor,
    ...rest: unknown[]
  ) => {
    if (String(file).endsWith("b.txt")) throw new Error("EACCES");
    return (real as (...args: unknown[]) => unknown)(file, ...rest);
  }) as typeof fs.readFileSync);
  try {
    const all = score(
      {
        type: "file_matches",
        path: "*.txt",
        pattern: "needle",
        quantifier: "all",
      },
      out,
    );
    expect(all).toEqual({
      score: 0,
      reason: "not every file matches /needle/: b.txt (unreadable)",
    });
    expect(
      score({ type: "file_matches", path: "*.txt", pattern: "needle" }, out)
        .score,
    ).toBe(1);
    expect(
      score({ type: "file_lacks", path: "b.txt", pattern: "zzz" }, out).score,
    ).toBe(0);
    expect(
      score({ type: "file_lines", path: "b.txt", min: 0 }, out).score,
    ).toBe(0);
  } finally {
    spy.mockRestore();
  }
});

test("a path through a link that leaves the workspace is absent", () => {
  const dirs = dirsWith({ "real/in.txt": "inside" });
  const outside = path.join(path.dirname(dirs.workspace), "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  const out = dirs.run(({ workspace }) => {
    fs.symlinkSync(outside, path.join(workspace, "out"));
    fs.symlinkSync(
      path.join(outside, "secret.txt"),
      path.join(workspace, "leak.txt"),
    );
    fs.symlinkSync(path.join(workspace, "real"), path.join(workspace, "alias"));
    fs.symlinkSync(
      path.join(workspace, "gone"),
      path.join(workspace, "dangling"),
    );
  });
  const zero = [
    { type: "file_exists", path: "out/secret.txt" },
    { type: "file_exists", path: "out/*" },
    { type: "file_exists", path: "out/**" },
    { type: "file_exists", path: "leak.txt" },
    { type: "file_exists", path: "dangling" },
    { type: "dir_exists", path: "out" },
    { type: "file_matches", path: "leak.txt", pattern: "secret" },
    { type: "file_matches", path: "*.txt", pattern: "secret" },
  ] as const;
  for (const check of zero) expect(score(check, out).score, check.path).toBe(0);
  const one = [
    { type: "file_absent", path: "out/secret.txt" },
    { type: "file_absent", path: "leak.txt" },
    { type: "file_lacks", path: "*.txt", pattern: "secret" },
  ] as const;
  for (const check of one) expect(score(check, out).score, check.path).toBe(1);
  expect(score({ type: "file_exists", path: "alias/in.txt" }, out).score).toBe(
    1,
  );
  expect(score({ type: "file_exists", path: "alias/*" }, out).score).toBe(0);
  expect(
    score({ type: "file_matches", path: "alias", pattern: "x" }, out).score,
  ).toBe(0);
});

test("a workspace that is gone leaves every check with its absent-file score", () => {
  const dirs = dirsWith(SEED);
  const out = dirs.run(({ workspace }) => {
    fs.rmSync(workspace, { recursive: true });
  });
  const table: [Given, number][] = [
    [{ type: "file_exists", path: "notes.txt" }, 0],
    [{ type: "file_matches", path: "src/*.ts", pattern: "x" }, 0],
    [{ type: "file_lacks", path: "src/*.ts", pattern: "x" }, 1],
    [{ type: "file_absent", path: "src/**" }, 1],
    [{ type: "file_unchanged", path: "tests/**" }, 0],
    [{ type: "file_unchanged", path: "nothing/**" }, 1],
    [{ type: "file_changed", path: "notes.txt" }, 1],
    [{ type: "files_changed_only", allow: ["src/**"] }, 0],
    [{ type: "files_changed_only", allow: ["**"] }, 1],
    [{ type: "file_count", path: "src/*" }, 0],
    [{ type: "dir_exists", path: "src" }, 0],
    [{ type: "file_lines", path: "notes.txt", max: 5 }, 0],
  ];
  for (const [check, expected] of table) {
    expect(score(check, out).score, JSON.stringify(check)).toBe(expected);
  }
});

test("root home reads the home, and the workspace stays the default", () => {
  const dirs = dirsWith({ "notes.txt": "x" });
  const out = dirs.run(({ home }) => {
    fs.mkdirSync(path.join(home, ".audit"));
    fs.writeFileSync(path.join(home, LOG), "audited");
  });
  const home = (check: Given) => score({ ...check, root: "home" }, out);
  expect(home({ type: "file_exists", path: LOG }).score).toBe(1);
  expect(score({ type: "file_exists", path: LOG }, out).score).toBe(0);
  expect(home({ type: "dir_exists", path: ".audit" }).score).toBe(1);
  expect(home({ type: "file_changed", path: ".audit/*" }).score).toBe(1);
  expect(home({ type: "file_exists", path: LOG, created: true }).score).toBe(1);
  expect(home({ type: "files_changed_only", allow: [".audit/**"] }).score).toBe(
    1,
  );
  expect(home({ type: "file_absent", path: "notes.txt" }).score).toBe(1);
  expect(home({ type: "file_unchanged", path: "notes.txt" }).score).toBe(1);
  expect(
    home({ type: "file_matches", path: LOG, pattern: "audit" }).score,
  ).toBe(1);
  expect(
    score({ type: "files_changed_only", allow: ["nothing"] }, out).score,
  ).toBe(1);
});

test("ten thousand matches hit the cap, with the glob and the cap named", () => {
  const dirs = dirsWith();
  const out = dirs.run(({ workspace }) => {
    const many = path.join(workspace, "many");
    fs.mkdirSync(many);
    for (let n = 0; n < 5001; n += 1)
      fs.writeFileSync(path.join(many, `${String(n)}.txt`), "");
  });
  const checks: Given[] = [
    { type: "file_count", path: MANY, min: 0 },
    { type: "file_absent", path: MANY },
    { type: "file_lacks", path: MANY, pattern: "x" },
    { type: "file_matches", path: MANY, pattern: "x" },
    { type: "file_exists", path: MANY },
    { type: "dir_exists", path: "many/**" },
    { type: "file_lines", path: MANY, min: 0 },
  ];
  for (const check of checks) {
    const verdict = score(check, out);
    expect(verdict.score, check.type).toBe(0);
    expect(verdict.reason, check.type).toBe(
      'the glob "' +
        (check.path ?? "") +
        '" matches more than 5000 paths, which is the cap; narrow the glob',
    );
  }
});

test("describeCheck shows the fields of the file checks", () => {
  const show = (check: Given) => describeCheck({ ...check, weight: 1 });
  expect(
    show({
      type: "file_lacks",
      path: "src/**",
      pattern: "as any",
      quantifier: "any",
      root: "home",
    }),
  ).toBe("file_lacks src/** quantifier any root home /as any/");
  expect(show({ type: "file_exists", path: "a", created: true })).toBe(
    "file_exists a created",
  );
  expect(
    show({
      type: "files_changed_only",
      allow: ["src/**", "docs/**"],
      ignore: ["*.log"],
    }),
  ).toBe("files_changed_only allow src/**, docs/** ignore *.log");
  expect(show({ type: "file_lines", path: "a", min: 1, max: 4 })).toBe(
    "file_lines a min 1 max 4",
  );
});

test("a file that vanishes between the listing and the stat is skipped, never a crash", () => {
  const dirs = dirsWith({ "a.txt": "x", "b.txt": "y" });
  const out = dirs.run();
  const real = fs.statSync;
  const spy = vi.spyOn(fs, "statSync").mockImplementation(((
    file: fs.PathLike,
    ...rest: unknown[]
  ) => {
    if (String(file).endsWith("b.txt")) throw new Error("ENOENT");
    return (real as (...args: unknown[]) => unknown)(file, ...rest);
  }) as typeof fs.statSync);
  try {
    expect(score({ type: "file_count", path: "*.txt" }, out).score).toBe(1);
    expect(
      score({ type: "file_count", path: "*.txt", min: 2 }, out).score,
    ).toBe(0);
  } finally {
    spy.mockRestore();
  }
});
