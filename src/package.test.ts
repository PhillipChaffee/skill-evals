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
      env: {
        ...process.env,
        SKILL_EVALS_BIN_CLAUDE_CODE: fakeHarness,
        // Never the operator's own state directory.
        SKILL_EVALS_STATE_DIR: path.join(root, "state"),
      },
    });
  return { project, files: tarball.files.map((file) => file.path), run };
}

/**
 * Runs the mock MCP server through the link that npm makes for its `bin` entry, and makes one call.
 * @param project - The project the tarball was installed into.
 */
function expectMockServer(project: string): void {
  const tool = path.join(project, "mock/tracker");
  fs.mkdirSync(tool, { recursive: true });
  fs.writeFileSync(
    path.join(tool, "get.json"),
    JSON.stringify({
      description: "d",
      inputSchema: {},
      responses: [{ text: "ok {{id}}" }],
    }),
  );
  const call = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "get", arguments: { id: "7" } },
  });
  const mock = spawnSync(
    path.join(project, "node_modules/.bin/skill-evals-mcp-mock"),
    ["tracker", tool],
    { input: `${call}\n`, encoding: "utf8" },
  );
  expect(mock.status, mock.stderr).toBe(0);
  expect(mock.stdout).toContain('"text":"ok 7"');
}

test(
  "the packed tarball holds compiled code only, and it lists, scores, and imports from another directory",
  () => {
    const { project, files, run } = installed();
    expect(files).toContain("dist/bin.js");
    expect(files).toContain("dist/index.d.ts");
    expect(files).toContain("dist/mcp/mock-server.js");
    expect(files).toContain("schema/case.schema.json");
    expect(files).toContain("schema/config.schema.json");
    // The examples ship, and some hold TypeScript files that are the material of a case, so `.ts` is unshipped
    // everywhere but under `examples/`: this change is deliberate.
    const unshipped =
      /^src\/|\.test\.|testing|^dist\/docs\/|^(?!examples\/).*\.ts$(?<!\.d\.ts)/;
    expect(files.filter((file) => unshipped.test(file))).toEqual([]);

    const bin = path.join(project, "node_modules/.bin/skill-evals");
    const list = run(bin, "list");
    expect(list.status, list.stderr).toBe(0);
    expect(list.stdout).toMatch(/pi.*claude-code.*cursor.*opencode.*codex/s);

    expectMockServer(project);

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
      "--yes",
    ];
    const scored = run(bin, "score", "--subject", "none", ...flags);
    expect(scored.status, scored.stderr).toBe(0);
    expect(scored.stdout).toMatch(
      /^Suite score: 1\.00 \(1 of 1 cases, 1 of 1 runs\)$/m,
    );
    expect(fs.existsSync(path.join(project, "results/results.json"))).toBe(
      true,
    );

    const script =
      'import("skill-evals").then((api) => console.log(Object.keys(api).sort().join()))';
    const imported = run(process.execPath, "-e", script);
    expect(imported.stdout.trim(), imported.stderr).toBe(
      "EXIT,HARNESSES,evaluate,exitCodeOf,loadCases",
    );
  },
  TIMEOUT_MS,
);

test("the tarball holds the examples, the schemas and the docs", () => {
  // `--ignore-scripts` skips the build that `prepack` runs: only the file list of the tarball is read.
  const listing = npm(
    packageDir,
    "pack",
    "--dry-run",
    "--json",
    "--ignore-scripts",
  );
  const [tarball] = JSON.parse(listing) as [{ files: { path: string }[] }];
  const files = tarball.files.map((file) => file.path);
  for (const wanted of [
    "examples/cases/hello/case.json",
    "examples/graders/text-metrics.mjs",
    "schema/case.schema.json",
    "docs/src/content/docs/reference/checks.md",
  ]) {
    expect(files).toContain(wanted);
  }
  expect(files.some((file) => file.startsWith("docs/design/"))).toBe(true);
  // Nothing else ships: every path starts with an allowed prefix, or is one of the named root files.
  const allowed =
    /^(dist\/|examples\/|schema\/|docs\/design\/|docs\/src\/content\/docs\/|README\.md$|LICENSE$|CHANGELOG\.md$|package\.json$)/;
  expect(files.filter((file) => !allowed.test(file))).toEqual([]);
});
