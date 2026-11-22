import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { escapesOf } from "./checks/escapes.js";
import type { ToolCall } from "./harnesses/shared.js";
import { gitRepo } from "./testing/sandbox.js";

const PUBLISH = "npm publish";
const shell = (command: unknown): ToolCall => ({
  name: "Bash",
  kind: "shell",
  input: { command },
});

/**
 * Makes a repository with remotes that point at other machines and at this one.
 * @returns The path of the repository, which is removed when the test ends.
 */
function repository(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "repo-")));
  onTestFinished(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const git = gitRepo(dir);
  git("remote", "add", "origin", "https://github.com/x/y.git");
  git("remote", "add", "mirror", "git@example.com:x/y.git");
  git("remote", "add", "bare", "../bare.git");
  git("remote", "add", "absolute", "/srv/bare.git");
  git("remote", "add", "split", "https://example.com/x.git");
  git("config", "remote.split.pushurl", "/srv/local.git");
  fs.mkdirSync(path.join(dir, "sub"));
  gitRepo(path.join(dir, "sub"));
  return dir;
}

const found = (command: string, workspace = ""): string[] =>
  escapesOf([shell(command)], workspace);

test("a git push to a non-local remote is recorded", () => {
  const dir = repository();
  expect(found("git push origin main", dir)).toEqual([
    "a git push to the non-local remote origin (call #0)",
  ]);
  expect(found("git push", dir)).toEqual([
    "a git push to the non-local remote origin (call #0)",
  ]);
  expect(found("git push mirror HEAD", dir)).toHaveLength(1);
  expect(found("git push https://github.com/x/y.git", dir)).toHaveLength(1);
  expect(found("git push git@github.com:x/y.git main")).toHaveLength(1);
  expect(found("git push ssh://host/x.git")).toHaveLength(1);
  expect(found("git push --repo=https://example.com/x.git", dir)).toHaveLength(
    1,
  );
  expect(found("git push --repo origin", dir)).toHaveLength(1);
  expect(found("git push --repo", dir)).toHaveLength(1);
  expect(
    found("git push -o ci.skip --force-with-lease origin main", dir),
  ).toHaveLength(1);
  expect(
    found("git -c push.default=simple -C . push --all origin", dir),
  ).toHaveLength(1);
  expect(found("FOO=1 git push origin", dir)).toHaveLength(1);
  expect(found("git --no-pager push origin", dir)).toHaveLength(1);
  expect(found("cd x && git add . && git push origin", dir)).toHaveLength(1);
  expect(found("sh -c 'git push origin main'", dir)).toHaveLength(1);
});

test("a push that stays on this machine, or does nothing, is not recorded", () => {
  const dir = repository();
  for (const command of [
    "git push bare main",
    "git push absolute",
    "git push split",
    "git push ../remote.git",
    "git push ./remote.git",
    "git push /tmp/remote.git",
    "git push file:///tmp/remote.git",
    "git push ~/remote.git",
    "git push nowhere",
    "git push",
    "git status",
    "git -C sub push",
    "git pull origin main",
    "git",
    "FOO=1",
    "git -C",
  ]) {
    expect(
      found(command, command === "git push" ? "/nonexistent" : dir),
      command,
    ).toEqual([]);
  }
});

test("a package or release publish is recorded", () => {
  for (const command of [
    PUBLISH,
    "npm publish --access public ./pkg",
    "pnpm publish",
    "yarn publish",
    "yarn npm publish",
    "cargo publish",
    "twine upload dist/*",
    "python3 -m twine upload dist/*",
    "gh release create v1 --notes x",
    "gh release upload v1 a.zip",
    "gh release edit v1",
    "gh release delete v1",
    "NODE_ENV=production npm publish",
  ]) {
    expect(found(command), command).toHaveLength(1);
  }
  expect(found(PUBLISH)).toEqual(["npm publish (call #0)"]);
  expect(found("python -m twine upload x")).toEqual(["twine upload (call #0)"]);
  expect(found("gh release create v1")).toEqual([
    "gh release create (call #0)",
  ]);
});

test("a publish that only looks, and commands that are not publishes, are not recorded", () => {
  for (const command of [
    "npm publish --dry-run",
    "cargo publish --dry-run",
    "npm install publish",
    "npm run build",
    "gh release view v1",
    "gh pr create",
    "twine check dist/*",
    "python -m pytest",
    "yarn",
    "cargo build",
    "echo npm publish",
    "ls",
  ]) {
    expect(found(command), command).toEqual([]);
  }
});

test("only shell calls with a command are read, and each reason names its call", () => {
  const calls: ToolCall[] = [
    { name: "Read", kind: "read", input: { command: PUBLISH } },
    shell(7),
    { name: "Bash", kind: "shell", input: null },
    shell("ls"),
    {
      ...shell("npm publish && git push https://example.com/x.git"),
      index: 12,
    },
  ];
  expect(escapesOf(calls, "")).toEqual([
    "npm publish (call #12)",
    "a git push to the non-local remote https://example.com/x.git (call #12)",
  ]);
});
