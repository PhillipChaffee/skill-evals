import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, onTestFinished, test } from "vitest";

const script = path.resolve(import.meta.dirname, "../scripts/release-plan.sh");

const VERSION = "1.2.0";
const TAG = `v${VERSION}`;
const VERSION_LINE = `version=${VERSION}`;
const PUBLISH = [VERSION_LINE, "publish=true"];
const ALREADY_PUBLISHED = [VERSION_LINE, "publish=false"];

// Stands in for `npm view <spec> version`. A spec with a version answers from ON_REGISTRY, a bare name from LATEST;
// an empty answer for a bare name is the registry's "no such package".
const NPM_STUB = `#!/usr/bin/env bash
if [[ -n \${REGISTRY_DOWN:-} ]]; then echo "npm error code ECONNRESET" >&2; exit 1; fi
if [[ $2 == *@* ]]; then echo "\${ON_REGISTRY:-}"; exit 0; fi
if [[ -z \${LATEST:-} ]]; then echo "npm error code E404" >&2; exit 1; fi
echo "$LATEST"
`;
// Stands in for `git merge-base --is-ancestor`, which exits 1 when the commit is not on the branch.
const GIT_STUB = `#!/usr/bin/env bash
if [[ -n \${OFF_MAIN:-} ]]; then exit 1; fi
exit 0
`;

/** The project, and what the registry and the history hold when the script asks. */
interface World {
  version?: string;
  changelog?: string;
  /** The version the registry returns for name@version, when it has it. */
  onRegistry?: string;
  /** The newest version on the registry, when the package exists. */
  latest?: string;
  registryDown?: boolean;
  /** The tag that was pushed. Set, it runs the script the way the publish workflow does. */
  pushedTag?: string;
  /** The tagged commit is not on main. */
  offMain?: boolean;
}

/**
 * Says which variables a world sets for the stand-ins and the script.
 * @param world - What the registry and the history hold.
 * @returns The variables, without the ones that world leaves out.
 */
const worldEnv = (world: World): Record<string, string> =>
  Object.fromEntries(
    Object.entries({
      ON_REGISTRY: world.onRegistry,
      LATEST: world.latest,
      REGISTRY_DOWN: world.registryDown === true ? "1" : undefined,
      OFF_MAIN: world.offMain === true ? "1" : undefined,
      GITHUB_REF_NAME: world.pushedTag,
      GITHUB_SHA: world.pushedTag === undefined ? undefined : "0123abc",
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

/**
 * Runs the release guard in a project where the registry and the history answer as told.
 * @param world - The project's version and changelog, and what the registry and the history hold.
 * @returns The script's exit status, its output lines, and what it wrote to standard error.
 */
function plan(world: World) {
  const { version = VERSION } = world;
  const { changelog = `# Changelog\n\n## ${version}\n` } = world;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-"));
  onTestFinished(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "npm"), NPM_STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "git"), GIT_STUB, { mode: 0o755 });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "some-package", version }),
  );
  fs.writeFileSync(path.join(dir, "CHANGELOG.md"), changelog);
  const args = world.pushedTag === undefined ? [] : ["release"];
  const result = spawnSync("bash", [script, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: {
      PATH: `${bin}${path.delimiter}${process.env["PATH"] ?? ""}`,
      ...worldEnv(world),
    },
  });
  return {
    status: result.status,
    lines: result.stdout.trim().split("\n"),
    stderr: result.stderr,
  };
}

test.each([
  ["a package that was never published", {}],
  ["a version above the latest one on the registry", { latest: "1.1.9" }],
  ["a matching tag on a commit that is on main", { pushedTag: TAG }],
])("%s is to be published", (_name, world: World) => {
  const { status, lines, stderr } = plan(world);
  expect(status, stderr).toBe(0);
  expect(lines).toEqual(PUBLISH);
});

test.each([
  ["a pull request", {}],
  ["a tag pushed again", { pushedTag: TAG }],
])(
  "a version that is on the registry is not published twice, for %s",
  (_name, world: World) => {
    const published = { onRegistry: VERSION, latest: VERSION };
    const { status, lines, stderr } = plan({ ...world, ...published });
    expect(status, stderr).toBe(0);
    expect(lines).toEqual(ALREADY_PUBLISHED);
  },
);

test.each([
  [
    "a version at or under the latest one",
    { latest: "1.10.0" },
    /version 1\.2\.0 is not above 1\.10\.0/,
  ],
  [
    "a version with no changelog entry",
    { changelog: "# Changelog\n\n## 1.1.0\n" },
    /CHANGELOG\.md has no "## 1\.2\.0" entry/,
  ],
  [
    "a version that is not three numbers",
    { version: "1.2.0-beta.1" },
    /version "1\.2\.0-beta\.1" is not MAJOR\.MINOR\.PATCH/,
  ],
  [
    "a registry that cannot be reached",
    { registryDown: true },
    /could not ask the registry about some-package@1\.2\.0/,
  ],
  [
    "a tag that is not the version in package.json",
    { pushedTag: "v1.3.0" },
    /the tag v1\.3\.0 is not v1\.2\.0/,
  ],
  [
    "a tag on a commit that is not on main",
    { pushedTag: TAG, offMain: true },
    /the tagged commit 0123abc is not on main/,
  ],
])("%s stops the release", (_name, world: World, reason) => {
  const { status, lines, stderr } = plan(world);
  expect(status).toBe(1);
  expect(stderr).toMatch(reason);
  expect(lines).toEqual([""]);
});
