import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { fakeHarness } from "./testing/sandbox.js";

const packageDir = path.resolve(import.meta.dirname, "..");
// Packing compiles the sources first, and installing unpacks the result.
const TIMEOUT_MS = 120_000;

const npm = (cwd: string, ...args: string[]): string =>
  execFileSync("npm", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

/**
 * Packs this package and installs the tarball into a new, empty project.
 * @returns The project directory, the files the tarball holds, and a `run` that starts a command there the way a
 *   user's shell would, with the fake harness standing in for Claude Code.
 */
function installed() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pack-")));
  onTestFinished(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  const packed = npm(packageDir, "pack", "--json", "--pack-destination", root);
  // Skips what the build that packing runs may print before the JSON.
  const listing = packed.slice(packed.search(/^\[$/m));
  const [tarball] = JSON.parse(listing) as [
    { filename: string; files: { path: string }[] },
  ];
  npm(project, "init", "-y");
  const flags = ["--no-audit", "--no-fund", "--offline"];
  npm(project, "install", ...flags, path.join(root, tarball.filename));
  const run = (command: string, ...args: string[]) =>
    spawnSync(command, args, {
      cwd: project,
      encoding: "utf8",
      env: { ...process.env, SKILL_EVALS_BIN_CLAUDE_CODE: fakeHarness },
    });
  return { project, files: tarball.files.map((file) => file.path), run };
}

test(
  "the packed tarball holds compiled code only, and it lists, scores, and imports from another directory",
  () => {
    const { project, files, run } = installed();
    expect(files).toContain("dist/bin.js");
    expect(files).toContain("dist/index.d.ts");
    const unshipped = /^src\/|\.test\.|testing|\.ts$(?<!\.d\.ts)/;
    expect(files.filter((file) => unshipped.test(file))).toEqual([]);

    const bin = path.join(project, "node_modules/.bin/skill-evals");
    const list = run(bin, "list");
    expect(list.status, list.stderr).toBe(0);
    expect(list.stdout).toMatch(/pi.*claude-code.*cursor.*opencode.*codex/s);

    const caseDir = path.join(project, "evals/cases/hello");
    fs.mkdirSync(caseDir, { recursive: true });
    fs.writeFileSync(path.join(caseDir, "prompt.md"), "say hello\n");
    const checks = [{ type: "file_exists", path: "out/summary.txt" }];
    fs.writeFileSync(
      path.join(caseDir, "case.json"),
      JSON.stringify({ checks }),
    );
    const flags = [
      "--harness",
      "claude-code",
      "--reps",
      "1",
      "--out",
      "results",
    ];
    const scored = run(bin, "score", "--subject", "none", ...flags);
    expect(scored.status, scored.stderr).toBe(0);
    expect(scored.stdout).toMatch(/^Suite score: 1\.00$/m);
    expect(fs.existsSync(path.join(project, "results/results.json"))).toBe(
      true,
    );

    const script =
      'import("skill-evals").then((api) => console.log(Object.keys(api).sort().join()))';
    const imported = run(process.execPath, "-e", script);
    expect(imported.stdout.trim(), imported.stderr).toBe(
      "HARNESSES,evaluate,loadCases",
    );
  },
  TIMEOUT_MS,
);
