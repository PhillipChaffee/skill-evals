import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { loadCases } from "./cases.js";
import { copyForRun, exportSubject } from "./isolate.js";
import { NO_EXCLUSIONS } from "./exclusions.js";
import { resolveSubject } from "./subject.js";
import { gitRepo, sandbox } from "./testing/sandbox.js";

/**
 * Exports a directory.
 * @param dir - The directory to export.
 * @param exclude - Globs to leave out.
 * @returns The export directory, and its `dispose`.
 */
const exportDir = (dir: string, exclude: string[] = []) =>
  exportSubject({ dir, commit: null, repoRoot: dir }, exclude);

test("exportSubject leaves out .git, node_modules and the given globs", () => {
  const box = sandbox();
  box.write("src/keep.txt", "k");
  box.write("src/.git/HEAD", "h");
  box.write("src/deep/node_modules/m.js", "m");
  box.write("src/cases/a/case.json", "{}");
  box.write("src/drop/me.txt", "d");
  const exported = exportDir(path.join(box.root, "src"), ["cases", "drop/**"]);
  const listed = fs
    .readdirSync(exported.dir, { recursive: true })
    .map(String)
    .sort();
  expect(listed).toEqual(["keep.txt"]);
  exported.dispose();
  expect(fs.existsSync(exported.dir)).toBe(false);
});

test("a link that stays inside the subject is kept as a link", () => {
  const box = sandbox();
  box.write("src/skills/x/SKILL.md", "x");
  fs.symlinkSync("skills/x", path.join(box.root, "src/alias"));
  const exported = exportDir(path.join(box.root, "src"));
  expect(fs.readlinkSync(path.join(exported.dir, "alias"))).toBe("skills/x");
  exported.dispose();
});

test("a link with an absolute target is outside the subject, even when the target is inside", () => {
  const box = sandbox();
  box.write("src/skills/x/SKILL.md", "x");
  fs.symlinkSync(
    path.join(box.root, "src/skills"),
    path.join(box.root, "src/absolute"),
  );
  expect(() => exportDir(path.join(box.root, "src"))).toThrow(
    /absolute path; links outside the subject/,
  );
});

test("a link that leaves the subject through a relative path names the link", () => {
  const box = sandbox();
  box.write("src/a.txt", "a");
  fs.symlinkSync("../other", path.join(box.root, "src/leaving"));
  expect(() => exportDir(path.join(box.root, "src"))).toThrow(
    /leaving is a link to \.\.\/other; links outside the subject/,
  );
});

test("copyForRun makes a fresh copy that reports what was changed in it", () => {
  const box = sandbox();
  box.write("src/a.txt", "a");
  const exported = exportDir(path.join(box.root, "src"));
  const first = copyForRun(exported.dir);
  fs.writeFileSync(path.join(first.dir, "a.txt"), "edited");
  expect(first.changes().modified).toEqual(["a.txt"]);
  const second = copyForRun(exported.dir);
  expect(second.changes()).toEqual({ created: [], modified: [], deleted: [] });
  expect(path.basename(second.dir)).toMatch(/^kit-/);
  first.dispose();
  second.dispose();
  exported.dispose();
});

test("a missing tar is a usage error that says so", () => {
  const box = sandbox();
  const repo = path.join(box.root, "repo");
  fs.mkdirSync(repo);
  box.write("repo/a.txt", "a");
  const git = gitRepo(repo);
  git("add", "-A");
  git("commit", "-q", "-m", "files");
  const commit = git("rev-parse", "HEAD");
  const bare = path.join(box.root, "gitonly");
  fs.mkdirSync(bare);
  fs.symlinkSync(
    path.join(box.env["PATH"] ?? "", "git"),
    path.join(bare, "git"),
  );
  vi.stubEnv("PATH", bare);
  try {
    expect(() =>
      exportSubject({ dir: repo, commit, repoRoot: repo }, []),
    ).toThrow(/tar is needed/);
  } finally {
    vi.unstubAllEnvs();
  }
});

test("a commit that does not exist is a usage error from git", () => {
  const box = sandbox();
  const repo = path.join(box.root, "repo");
  fs.mkdirSync(repo);
  gitRepo(repo);
  expect(() =>
    exportSubject({ dir: repo, commit: "0".repeat(40), repoRoot: repo }, []),
  ).toThrow(/git archive failed/);
});

test("a git program that cannot start is a usage error that names it", () => {
  const box = sandbox();
  const repo = path.join(box.root, "repo");
  fs.mkdirSync(repo);
  vi.stubEnv("PATH", box.root);
  try {
    expect(() =>
      exportSubject({ dir: repo, commit: "a".repeat(40), repoRoot: repo }, []),
    ).toThrow(/git is needed/);
  } finally {
    vi.unstubAllEnvs();
  }
});

test("the documented example case loads", () => {
  const examples = path.resolve(import.meta.dirname, "../examples/cases");
  const [loaded] = loadCases(examples, "subject_unchanged");
  expect(loaded?.checks.map((check) => check.type)).toEqual([
    "subject_unchanged",
    "output_contains",
  ]);
});

test.each([
  [{ subjectExclude: "notes" }, /"subjectExclude" must be a list of strings/],
  [{ subjectExclude: [""] }, /"subjectExclude" has an empty glob/],
  [{ subjectExclude: ["{a"] }, /unclosed "\{" in the glob \{a/],
])("the config %j is a usage error", async (config, message) => {
  const box = sandbox();
  box.write("skill-evals.config.json", config);
  const listed = await box.cli(["list"]);
  expect(listed.status).toBe(2);
  expect(listed.stderr).toMatch(message);
});

test("a directory that is empty only because of an exclusion is not left behind, and one that was empty stays", () => {
  const box = sandbox();
  box.write("src/evals/cases/one/case.json", "{}");
  box.write("src/a/b/c/secret.txt", "s");
  box.write("src/keep.txt", "k");
  fs.mkdirSync(path.join(box.root, "src/was-empty"));
  const exported = exportDir(path.join(box.root, "src"), [
    "evals/cases",
    "a/b/c",
  ]);
  expect(
    fs.readdirSync(exported.dir, { recursive: true }).map(String).sort(),
  ).toEqual(["keep.txt", "was-empty"]);
  exported.dispose();
});

test("a commit export drops the directories that its exclusions emptied", () => {
  const box = sandbox();
  const repo = path.join(box.root, "repo");
  fs.mkdirSync(repo);
  box.write("repo/evals/cases/one/case.json", "{}");
  box.write("repo/keep.txt", "k");
  const git = gitRepo(repo);
  git("add", "-A");
  git("commit", "-q", "-m", "files");
  const exported = exportSubject(
    { dir: repo, commit: git("rev-parse", "HEAD"), repoRoot: repo },
    ["evals/cases"],
  );
  expect(fs.readdirSync(exported.dir)).toEqual(["keep.txt"]);
  exported.dispose();
});

test("a link chain that leaves the subject is a load error", () => {
  const box = sandbox();
  box.write("outside/s.txt", "secret");
  box.write("src/sub/deep/keep.txt", "k");
  const deep = path.join(box.root, "src/sub/deep");
  fs.symlinkSync("../..", path.join(deep, "L"));
  fs.symlinkSync("L/../outside/s.txt", path.join(deep, "a"));
  expect(() => exportDir(path.join(box.root, "src"))).toThrow(
    /sub\/deep\/a is a link to L\/\.\.\/outside\/s\.txt; links outside the subject/,
  );
});

test("a link that dangles inside the subject is kept", () => {
  const box = sandbox();
  box.write("src/a.txt", "a");
  fs.symlinkSync("missing/file", path.join(box.root, "src/dangling"));
  const exported = exportDir(path.join(box.root, "src"));
  expect(fs.readlinkSync(path.join(exported.dir, "dangling"))).toBe(
    "missing/file",
  );
  exported.dispose();
});

test("a socket in the subject is a usage error that names it", async () => {
  const box = sandbox();
  box.write("src/a.txt", "a");
  const socket = path.join(box.root, "src/live.sock");
  const server = net.createServer();
  await new Promise<void>((resolve) => {
    server.listen(socket, resolve);
  });
  try {
    expect(() => exportDir(path.join(box.root, "src"))).toThrow(
      new RegExp(`${socket}.*socket, a pipe or a device`),
    );
  } finally {
    server.close();
  }
});

test("a copy that fails for another reason is a usage error that says what could not be copied", () => {
  const box = sandbox();
  box.write("src/a.txt", "a");
  vi.spyOn(fs, "cpSync").mockImplementation(() => {
    throw new Error("EACCES: permission denied, open 'a.txt'");
  });
  try {
    expect(() => exportDir(path.join(box.root, "src"))).toThrow(
      /cannot copy the subject .*src: EACCES/,
    );
  } finally {
    vi.restoreAllMocks();
  }
});

test("an edit of the export is reported by changed", () => {
  const box = sandbox();
  box.write("src/a.txt", "a");
  const exported = exportDir(path.join(box.root, "src"));
  expect(exported.changed()).toEqual([]);
  fs.writeFileSync(path.join(exported.dir, "a.txt"), "edited");
  expect(exported.changed()).toEqual(["a.txt"]);
  exported.dispose();
});

test("a cases directory that is or contains the subject, and an output directory that is the subject, are usage errors", () => {
  const box = sandbox();
  box.write("outer/kit/skills/x/SKILL.md", "x");
  const outer = path.join(box.root, "outer");
  const kit = path.join(outer, "kit");
  const project = { root: box.root, isGitRepo: false, cwd: box.root };
  const resolve = (left: { cases: string | null; out: string | null }) =>
    resolveSubject("subject", kit, {
      ...project,
      left: { ...NO_EXCLUSIONS, ...left },
    });
  expect(() => resolve({ cases: kit, out: null })).toThrow(
    new RegExp(
      `cases directory ${kit} is, or contains, the subject directory ${kit}`,
    ),
  );
  expect(() => resolve({ cases: outer, out: null })).toThrow(
    /is, or contains, the subject directory/,
  );
  expect(() => resolve({ cases: null, out: kit })).toThrow(
    new RegExp(`output directory ${kit} is the subject directory ${kit}`),
  );
  resolve({
    cases: path.join(kit, "cases"),
    out: path.join(kit, "out"),
  }).dispose();
});
