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
  expect(found("cd . && git add . && git push origin", dir)).toHaveLength(1);
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

test("a leading cd moves the repository that the push is looked up in", () => {
  const dir = repository();
  expect(found("cd sub && git push origin", dir)).toEqual([]);
  expect(found("cd sub; cd .. && git push origin", dir)).toHaveLength(1);
  expect(found(`cd ${dir}/sub && git push origin`, "/elsewhere")).toEqual([]);
  expect(found("cd && git push origin", dir)).toHaveLength(1);
});

test("a push with no remote goes where the branch's pushRemote, then remote.pushDefault, then origin says", () => {
  const dir = repository();
  const git = gitRepo(path.join(dir, "sub"));
  git("remote", "add", "origin", "https://example.com/o.git");
  git("remote", "add", "mine", "../mine.git");
  git("remote", "add", "other", "ssh://example.com/p.git");
  expect(found("git push", path.join(dir, "sub"))).toHaveLength(1);
  git("config", "remote.pushDefault", "mine");
  expect(found("git push", path.join(dir, "sub"))).toEqual([]);
  const branch = git("symbolic-ref", "--short", "HEAD");
  git("config", `branch.${branch}.pushRemote`, "other");
  expect(found("git push", path.join(dir, "sub"))).toHaveLength(1);
  // A refspec is not a remote: HEAD:main goes where the default goes.
  git("config", "--unset", `branch.${branch}.pushRemote`);
  expect(found("git push HEAD:main", path.join(dir, "sub"))).toEqual([]);
  expect(
    found("git push origin HEAD:main", path.join(dir, "sub")),
  ).toHaveLength(1);
  expect(found("git push +main:main", path.join(dir, "sub"))).toEqual([]);
});

test("wrappers and the values of options do not hide a push or a publish", () => {
  const dir = repository();
  for (const command of [
    "env -i FOO=1 git push origin",
    "env -u X git push origin",
    "env -- git push origin",
    "timeout 30 git push origin",
    "timeout -s KILL 30 git push origin",
    "timeout --signal=KILL 30 git push origin",
    "command git push origin",
    "nice -n 5 git push origin",
    "nice -5 git push origin",
    "sudo -u root git push origin",
    "sudo git push origin",
    "npx npm publish",
    "npx -p tool npm publish",
    "FOO=1 timeout 5 sudo env X=1 npm publish",
  ]) {
    expect(found(command, dir), command).toHaveLength(1);
  }
  for (const command of [
    "npm --prefix pkg publish",
    "npm --registry http://localhost:4873 publish",
    "gh -R owner/repo release create v1",
    "cargo --manifest-path a/Cargo.toml publish",
    "uv publish",
    "poetry publish",
    "docker push example/image",
    "docker image push example/image",
    "gem push thing.gem",
  ]) {
    expect(found(command), command).toHaveLength(1);
  }
  expect(found("docker build .")).toEqual([]);
  expect(found("timeout 5")).toEqual([]);
  expect(found("sudo")).toEqual([]);
});

test("a git push that only looks is not recorded", () => {
  const dir = repository();
  for (const command of [
    "git push --dry-run origin",
    "git push -n origin",
    "git push -nf origin",
    "git push origin --dry-run",
  ]) {
    expect(found(command, dir), command).toEqual([]);
  }
  expect(found("git push -f origin", dir)).toHaveLength(1);
  expect(found("git push --no-verify origin", dir)).toHaveLength(1);
});

test("a reason never holds the user or password of a URL", () => {
  const [reason] = found(
    "git push https://user:s3cret@github.com/x/y.git main",
  );
  expect(reason).toBe(
    "a git push to the non-local remote https://github.com/x/y.git (call #0)",
  );
  const [named] = found("git push --repo=https://tok@example.com/x.git");
  expect(named).not.toContain("tok");
  expect(found("git push git@github.com:x/y.git")[0]).toContain(
    "git@github.com:x/y.git",
  );
});

test("pnpm -r publish, more wrappers, docker's host option and a push option's value are read as they are", () => {
  for (const command of [
    "pnpm -r publish",
    "pnpm -w publish",
    "pnpm --filter pkg publish",
    "exec npm publish",
    "time npm publish",
    "time -p npm publish",
    "nohup npm publish",
    "docker -H ssh://host push example/image",
    "docker --host tcp://h:1 push example/image",
  ]) {
    expect(found(command), command).toHaveLength(1);
  }
  const dir = repository();
  // The value of -o is not a flag of the push, so a value of -n is no dry run.
  expect(found("git push -o -n origin", dir)).toHaveLength(1);
  expect(found("git push --push-option --dry-run origin", dir)).toHaveLength(1);
  expect(found("git push -o ci.skip -n origin", dir)).toEqual([]);
});

test("a push with no remote follows the branch's own remote before origin, after pushRemote and pushDefault", () => {
  const dir = repository();
  const git = gitRepo(path.join(dir, "sub"));
  git("remote", "add", "origin", "https://example.com/o.git");
  git("remote", "add", "local", "../local.git");
  const branch = git("symbolic-ref", "--short", "HEAD");
  git("config", `branch.${branch}.remote`, "local");
  expect(found("git push", path.join(dir, "sub"))).toEqual([]);
  git("config", "remote.pushDefault", "origin");
  expect(found("git push", path.join(dir, "sub"))).toHaveLength(1);
});

test("the password of a URL may hold an @, and none of it is shown", () => {
  const [reason] = found("git push https://user:p@ss@github.com/x/y.git");
  expect(reason).toBe(
    "a git push to the non-local remote https://github.com/x/y.git (call #0)",
  );
});
