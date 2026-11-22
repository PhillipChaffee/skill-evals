import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { watchCanaries } from "./canaries.js";
import { HARNESSES } from "./harnesses/index.js";
import { confinementOf } from "./run-confine.js";
import { gitRepo } from "./testing/sandbox.js";

const CHECK = { type: "no_writes_outside_workspace" };
const GIT_FILE = "project:src/a.ts";
const CLAUDE_JSON = ".claude.json";
const CLAUDE_LABEL = "~/.claude.json";
const CAP = "the project root holds more than 5000 files";

/**
 * Makes a directory that is removed when the test ends.
 * @param files - Relative path to content.
 * @returns The directory.
 */
function tree(files: Record<string, string>): string {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "canary-")),
  );
  onTestFinished(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  return dir;
}

test("a canary may be a file or a directory, the project is optional, and an output directory elsewhere is not skipped", () => {
  const home = tree({
    ".config/tool/a": "1",
    ".config/other/b": "1",
    ".kept": "1",
    ".one": "1",
  });
  const watch = watchCanaries({
    home,
    canaries: [{ path: ".config/tool" }, { path: ".one" }, { path: ".absent" }],
    root: null,
    out: null,
  });
  fs.writeFileSync(path.join(home, ".config/other/b"), "2");
  fs.writeFileSync(path.join(home, ".kept"), "2");
  expect(watch().changed).toEqual([]);
  fs.writeFileSync(path.join(home, ".config/tool/a"), "2");
  fs.writeFileSync(path.join(home, ".one"), "2");
  expect(watch().changed).toEqual([
    "~/.config/tool/a (modified)",
    "~/.one (modified)",
  ]);
  const project = tree({
    "src/a.ts": "1",
    "node_modules/x/i.js": "1",
    ".git/HEAD": "1",
  });
  const out = tree({});
  const around = watchCanaries({ home, canaries: [], root: project, out });
  fs.writeFileSync(path.join(project, "node_modules/x/i.js"), "2");
  fs.writeFileSync(path.join(project, ".git/HEAD"), "2");
  fs.writeFileSync(path.join(out, "results.json"), "{}");
  expect(around().changed).toEqual([]);
  fs.writeFileSync(path.join(project, "src/a.ts"), "2");
  expect(around().changed).toEqual([`${GIT_FILE} (modified)`]);
  const unnamed = watchCanaries({
    home,
    canaries: [],
    root: project,
    out: null,
  });
  fs.writeFileSync(path.join(project, "src/b.ts"), "1");
  expect(unnamed().changed).toEqual(["project:src/b.ts (created)"]);
});

test("a json canary hashes only the keys it names, and wildcards reach every project", () => {
  const first = {
    numStartups: 1,
    mcpServers: { a: { command: "x" } },
    projects: {
      "/p": { allowedTools: ["Bash"], history: [1], mcpServers: {} },
      "/q": { history: [] },
    },
  };
  const home = tree({ [CLAUDE_JSON]: JSON.stringify(first) });
  const file = path.join(home, CLAUDE_JSON);
  const watch = watchCanaries({
    home,
    canaries: [
      {
        path: CLAUDE_JSON,
        json: [
          "mcpServers",
          "projects.*.mcpServers",
          "projects.*.allowedTools",
        ],
      },
    ],
    root: null,
    out: null,
  });
  // What a live session rewrites all the time is not watched.
  fs.writeFileSync(
    file,
    JSON.stringify({
      ...first,
      numStartups: 9,
      projects: {
        "/p": { ...first.projects["/p"], history: [1, 2] },
        "/q": { history: [3] },
      },
    }),
  );
  expect(watch().changed).toEqual([]);
  fs.writeFileSync(
    file,
    JSON.stringify({ ...first, mcpServers: { a: { command: "evil" } } }),
  );
  expect(watch().changed).toEqual([`${CLAUDE_LABEL}#mcpServers (modified)`]);
  fs.writeFileSync(
    file,
    JSON.stringify({
      ...first,
      projects: { "/q": { allowedTools: ["*"], history: [] } },
    }),
  );
  expect(watch().changed).toEqual([
    `${CLAUDE_LABEL}#projects./q.allowedTools (created)`,
    `${CLAUDE_LABEL}#projects./p.allowedTools (deleted)`,
    `${CLAUDE_LABEL}#projects./p.mcpServers (deleted)`,
  ]);
});

test("a json canary that is not JSON is hashed whole, and a missing one is nothing", () => {
  const home = tree({ [CLAUDE_JSON]: "{ not json" });
  const watch = watchCanaries({
    home,
    canaries: [
      { path: CLAUDE_JSON, json: ["mcpServers"] },
      { path: ".none.json", json: ["a"] },
    ],
    root: null,
    out: null,
  });
  expect(watch().changed).toEqual([]);
  fs.writeFileSync(path.join(home, CLAUDE_JSON), "{ still not");
  expect(watch().changed).toEqual([`${CLAUDE_LABEL} (modified)`]);
  fs.writeFileSync(path.join(home, ".none.json"), "{}");
  expect(watch().changed).toContain(`${CLAUDE_LABEL} (modified)`);
});

test("a git project over the cap is not fully watched, whatever order git lists it in", () => {
  const files: Record<string, string> = { "z/secret.txt": "1" };
  for (let at = 0; at < 5100; at++) files[`a/${String(at)}.txt`] = "x";
  const project = tree(files);
  const git = gitRepo(project);
  git("add", "-A");
  const watch = watchCanaries({
    home: tree({}),
    canaries: [],
    root: project,
    out: null,
  });
  fs.writeFileSync(path.join(project, "z/secret.txt"), "2");
  const report = watch();
  expect(report.problems).toEqual([CAP]);
});

test("a project that is not a git repository and holds more than the cap is not fully watched", () => {
  const files: Record<string, string> = {};
  for (let at = 0; at < 5100; at++) files[`a/${String(at)}.txt`] = "x";
  const watch = watchCanaries({
    home: tree({}),
    canaries: [],
    root: tree(files),
    out: null,
  });
  expect(watch().problems).toEqual([CAP]);
});

test("a directory canary over the cap is not fully watched", () => {
  const files: Record<string, string> = {};
  for (let at = 0; at < 5100; at++) files[`.skills/${String(at)}.md`] = "x";
  const watch = watchCanaries({
    home: tree(files),
    canaries: [{ path: ".skills" }],
    root: null,
    out: null,
  });
  expect(watch().problems).toEqual(["~/.skills holds more than 5000 files"]);
});

test("a git project is listed by git: ignored files are left out and untracked ones are seen", () => {
  const project = tree({
    "src/a.ts": "1",
    "build/out.js": "1",
    ".gitignore": "build/\n",
  });
  const git = gitRepo(project);
  git("add", "-A");
  const watch = watchCanaries({
    home: tree({}),
    canaries: [],
    root: project,
    out: null,
  });
  fs.writeFileSync(path.join(project, "build/out.js"), "2");
  fs.writeFileSync(path.join(project, "new.ts"), "1");
  fs.rmSync(path.join(project, "src/a.ts"));
  expect(watch().changed).toEqual([
    "project:new.ts (created)",
    `${GIT_FILE} (deleted)`,
  ]);
});

test("the sandbox and the canaries of a run follow the plan and the case", () => {
  const harness = HARNESSES[0] as (typeof HARNESSES)[number];
  const caseDef = (checks: unknown[]) => ({ checks, turns: null }) as never;
  const base = {
    harness,
    bin: "claude",
    projectRoot: undefined,
    casesDir: undefined,
    outDir: "/out",
  };
  const plain = confinementOf({
    ...base,
    sandbox: undefined,
    caseDef: caseDef([{ type: "output_contains" }]),
  });
  expect(plain).toEqual({});
  const watched = confinementOf({
    ...base,
    sandbox: { backend: "bwrap", network: ["off", "open"] },
    caseDef: caseDef([CHECK]),
  });
  expect(watched.sandbox).toMatchObject({ backend: "bwrap", network: "open" });
  expect(watched.canaries).toMatchObject({ root: null, out: "/out" });
});
