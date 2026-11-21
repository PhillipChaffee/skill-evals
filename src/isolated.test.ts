import path from "node:path";
import { expect, test } from "vitest";
import claudeCode from "./harnesses/claude-code.js";
import type { Loaded, LoadedSubject } from "./harnesses/shared.js";
import { foreignOf } from "./harnesses/shared.js";
import { plantCase, plugin, script, skillsFolder } from "./testing/plant.js";
import { readResults, sandbox } from "./testing/sandbox.js";

const ISOLATED = "--isolated";
const NONE = "none";
const KIT_COPY = "/run/kit-1";
const ORG_PLUGIN = "/opt/org/plugin";
const NOTHING: Loaded = {
  paths: null,
  skills: null,
  agents: null,
  rules: null,
  hooks: null,
  mcpServers: null,
};

/**
 * Runs the planted case once.
 * @param box - The sandbox, with its scripts already written.
 * @param more - What to run.
 * @param more.subject - The subject to score.
 * @param more.flags - More flags of the command.
 * @param more.env - More environment variables of the command.
 * @returns What the command did and wrote.
 */
async function scoreOnce(
  box: ReturnType<typeof sandbox>,
  more: {
    subject: string;
    flags: string[];
    env?: Record<string, string>;
  },
) {
  const cases = plantCase(box, [{ type: "output_contains", text: "done" }]);
  const outDir = path.join(box.root, "results");
  const result = await box.cli(
    [
      "score",
      "--subject",
      more.subject,
      "--cases",
      cases,
      "--reps",
      "1",
      ...more.flags,
      "--out",
      outDir,
    ],
    more.env ?? {},
  );
  return { result, ...readResults(outDir) };
}

const done = [[{ final: "done" }]];

test("--a none --isolated records zero skills", async () => {
  const box = sandbox();
  script(box, "empty", { init: { skills: [] }, turns: done });
  const { result, records, invalid } = await scoreOnce(box, {
    subject: NONE,
    flags: [ISOLATED],
  });
  expect(result.status, result.stderr).toBe(0);
  expect(records[0]?.loaded.skills).toEqual([]);
  expect(records[0]?.unexpected).toEqual([]);
  expect(invalid).toEqual([]);
});

test("an extra plugin under --isolated invalidates the run", async () => {
  const box = sandbox();
  script(box, "org", {
    init: { plugins: [{ name: "org", path: ORG_PLUGIN }] },
    turns: done,
  });
  const { result, invalid, records } = await scoreOnce(box, {
    subject: NONE,
    flags: [ISOLATED],
  });
  expect(result.status).toBe(1);
  expect(invalid[0]).toMatch(/loaded outside the subject: \/opt\/org\/plugin/);
  expect(records[0]?.score).toBeNull();
  expect(records[0]?.unexpected).toEqual([ORG_PLUGIN]);
});

test("the same extra plugin without --isolated is recorded and the run counts", async () => {
  const box = sandbox();
  script(box, "org", {
    init: { plugins: [{ name: "org", path: ORG_PLUGIN }] },
    turns: done,
  });
  const { result, invalid, records } = await scoreOnce(box, {
    subject: NONE,
    flags: [],
  });
  expect(result.status, result.stderr).toBe(0);
  expect(invalid).toEqual([]);
  expect(records[0]?.loaded.paths).toEqual([ORG_PLUGIN]);
  expect(records[0]?.unexpected).toEqual([ORG_PLUGIN]);
  expect(records[0]?.score).toBe(1);
});

test("the subject's own plugin and its skills are not foreign, and another plugin's skill is", async () => {
  const box = sandbox();
  const kit = plugin(box, "kit", {});
  script(box, "own", {
    init: { skills: ["plugin:greet", "init", "org:thing"] },
    turns: done,
  });
  const { invalid, records } = await scoreOnce(box, {
    subject: kit,
    flags: [ISOLATED],
  });
  expect(records[0]?.unexpected).toEqual(["skill org:thing"]);
  expect(invalid[0]).toMatch(/loaded outside the subject: skill org:thing$/);
});

test("a skills folder, and a bare name that is a Claude Code built-in, load cleanly under --isolated", async () => {
  const box = sandbox();
  const skills = skillsFolder(box, "skills", { greet: "# greet\n" });
  script(box, "bare", { init: { skills: ["greet", "init"] }, turns: done });
  const { result, invalid } = await scoreOnce(box, {
    subject: skills,
    flags: [ISOLATED],
  });
  expect(result.status, result.stderr).toBe(0);
  expect(invalid).toEqual([]);
});

test("a harness that reports agents and servers shows what is foreign", async () => {
  const box = sandbox();
  script(box, "more", {
    init: { agents: ["reviewer"], mcp_servers: [{ name: "db" }] },
    turns: done,
  });
  const { records } = await scoreOnce(box, { subject: NONE, flags: [] });
  expect(records[0]?.loaded.agents).toEqual(["reviewer"]);
  expect(records[0]?.loaded.mcpServers).toEqual(["db"]);
});

test("pi runs under --isolated, and reports nothing it could not see", async () => {
  const box = sandbox();
  const { result, records } = await scoreOnce(box, {
    subject: NONE,
    flags: [ISOLATED, "--harness", "pi"],
    env: { SKILL_EVALS_BIN_PI: box.pi },
  });
  expect(result.status, result.stderr).toBe(0);
  expect(records[0]?.loaded).toEqual(NOTHING);
  expect(records[0]?.isolated).toBe(true);
});

test("--isolated with a harness that cannot isolate is a usage error that names it", async () => {
  const box = sandbox();
  const cases = plantCase(box, [{ type: "output_contains", text: "done" }]);
  const result = await box.cli(
    [
      "score",
      "--subject",
      NONE,
      "--cases",
      cases,
      ISOLATED,
      "--harness",
      "codex,pi",
    ],
    { SKILL_EVALS_BIN_CODEX: box.pi, SKILL_EVALS_BIN_PI: box.pi },
  );
  expect(result.status).toBe(2);
  expect(result.stderr).toMatch(/--isolated.*codex/);
  expect(result.stderr).not.toMatch(/pi/);
});

test("isolated can be set in the config file", async () => {
  const box = sandbox();
  box.write("skill-evals.config.json", { isolated: true });
  script(box, "org", {
    init: { plugins: [{ name: "org", path: ORG_PLUGIN }] },
    turns: done,
  });
  const cases = plantCase(box, [{ type: "output_contains", text: "done" }]);
  const result = await box.cli([
    "score",
    "--subject",
    NONE,
    "--cases",
    cases,
    "--reps",
    "1",
  ]);
  expect(result.status).toBe(1);
  expect(result.stdout).toMatch(/loaded outside the subject/);
});

const copy = (kind: LoadedSubject["kind"]): LoadedSubject => ({
  kind,
  dir: KIT_COPY,
  skills: ["greet"],
  skillDirs: {},
});

test("the default foreign list names every reported plugin path, skill, agent, server and hook the subject does not own", () => {
  const loaded: Loaded = {
    paths: [KIT_COPY, "/other"],
    skills: ["greet", "stray"],
    agents: ["a"],
    rules: ["r"],
    hooks: ["h"],
    mcpServers: ["m"],
  };
  const plain = {};
  expect(foreignOf(plain, loaded, copy("plugin"))).toEqual([
    "/other",
    "skill stray",
    "agent a",
    "MCP server m",
    "hook h",
  ]);
  expect(foreignOf(plain, loaded, null)).toContain(KIT_COPY);
  expect(foreignOf(plain, loaded, copy("skills"))).toContain(KIT_COPY);
  expect(foreignOf(plain, NOTHING, null)).toEqual([]);
});

test("claude-code treats a prefixed skill of another plugin as foreign and a bare name as a built-in", () => {
  const loaded: Loaded = {
    ...NOTHING,
    paths: [KIT_COPY, "/org"],
    skills: ["greet", "x", "init"],
    rawSkills: ["kit:greet", "org:x", "init"],
    plugins: [
      { name: "kit", path: KIT_COPY },
      { name: "org", path: "/org" },
    ],
  };
  expect(foreignOf(claudeCode, loaded, copy("plugin"))).toEqual([
    "/org",
    "skill org:x",
  ]);
});
