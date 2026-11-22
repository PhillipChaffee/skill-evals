import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { requireIsolation } from "./harnesses/index.js";
import { plantCase, plugin, script, skillsFolder } from "./testing/plant.js";
import { readResults, sandbox } from "./testing/sandbox.js";
import { EXIT } from "./exit-codes.js";

const ISOLATED = "--isolated";
const NONE = "none";
const ORG_PLUGIN = "/opt/org/plugin";

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
  expect(fs.existsSync(box.started)).toBe(true);
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
  expect(result.status).toBe(EXIT.invalid);
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

test("an agent or an MCP server that is not the subject's invalidates the run, and the record names it", async () => {
  const box = sandbox();
  script(box, "more", {
    init: {
      agents: ["Explore", "org:reviewer"],
      mcp_servers: [{ name: "db" }],
    },
    turns: done,
  });
  const { records, invalid } = await scoreOnce(box, {
    subject: NONE,
    flags: [ISOLATED],
  });
  expect(records[0]?.loaded.agents).toEqual(["Explore", "org:reviewer"]);
  expect(records[0]?.loaded.mcpServers).toEqual(["db"]);
  expect(records[0]?.unexpected).toEqual([
    "agent org:reviewer",
    "MCP server db",
  ]);
  expect(invalid[0]).toMatch(
    /loaded outside the subject: agent org:reviewer, MCP server db$/,
  );
});

test("the subject plugin's own agents and MCP servers are not foreign", async () => {
  const box = sandbox();
  const kit = plugin(box, "kit", {});
  script(box, "own", {
    init: {
      agents: ["plugin:reviewer"],
      mcp_servers: [{ name: "plugin:plugin:db" }],
    },
    turns: done,
  });
  const { records, result } = await scoreOnce(box, {
    subject: kit,
    flags: [ISOLATED],
  });
  expect(result.status, result.stderr).toBe(0);
  expect(records[0]?.unexpected).toEqual([]);
});

test("a skill an account syncs into the config directory during the run invalidates an isolated run", async () => {
  const box = sandbox();
  script(box, "sync", { syncSkill: "acct", turns: done });
  const isolated = await scoreOnce(box, { subject: NONE, flags: [ISOLATED] });
  expect(isolated.result.status).toBe(EXIT.invalid);
  expect(isolated.records[0]?.unexpected).toEqual(["account skill acct"]);
  expect(isolated.invalid[0]).toMatch(
    /loaded outside the subject: account skill acct$/,
  );
  fs.rmSync(path.join(box.root, "results"), { recursive: true });
  const plain = await scoreOnce(box, { subject: NONE, flags: [] });
  expect(plain.result.status, plain.result.stderr).toBe(0);
  expect(plain.invalid).toEqual([]);
});

test("the skills the run placed are not account skills", async () => {
  const box = sandbox();
  const skills = skillsFolder(box, "skills", { greet: "# greet\n" });
  script(box, "placed", { init: { skills: ["greet"] }, turns: done });
  const { result, records } = await scoreOnce(box, {
    subject: skills,
    flags: [ISOLATED],
  });
  expect(result.status, result.stderr).toBe(0);
  expect(records[0]?.unexpected).toEqual([]);
});

const NOT_REPORTED_REASON = /the harness did not report what it loaded$/;

test.each([
  ["no init event", { noInit: true }],
  ["an init event without plugins", { initOmit: ["plugins" as const] }],
  ["an init event without skills", { initOmit: ["skills" as const] }],
])(
  "%s under --isolated invalidates the run, and without it the run counts",
  async (_name, more) => {
    const box = sandbox();
    script(box, "partial", { ...more, turns: done });
    const isolated = await scoreOnce(box, { subject: NONE, flags: [ISOLATED] });
    expect(isolated.result.status).toBe(EXIT.invalid);
    expect(isolated.invalid[0]).toMatch(NOT_REPORTED_REASON);
    expect(isolated.records[0]?.score).toBeNull();
    fs.rmSync(path.join(box.root, "results"), { recursive: true });
    const plain = await scoreOnce(box, { subject: NONE, flags: [] });
    expect(plain.result.status, plain.result.stderr).toBe(0);
    expect(plain.invalid).toEqual([]);
  },
);

test("--isolated with a harness that cannot isolate is a usage error that names it, before any harness starts", async () => {
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
      "codex,pi,claude-code",
    ],
    { SKILL_EVALS_BIN_CODEX: box.pi, SKILL_EVALS_BIN_PI: box.pi },
  );
  expect(result.status).toBe(2);
  expect(result.stderr).toMatch(/--isolated cannot run with codex, pi:/);
  // Claude Code can isolate, so it is not among the harnesses the message names.
  expect(result.stderr).not.toMatch(/cannot run with [^:]*claude-code/);
  expect(fs.existsSync(box.started)).toBe(false);
});

test("--isolated with a judge harness that cannot isolate is a usage error that names it, before any harness starts", async () => {
  const box = sandbox();
  const cases = plantCase(box, [{ type: "judge", rubric: "Says done." }]);
  const result = await box.cli(
    [
      "score",
      "--subject",
      NONE,
      "--cases",
      cases,
      ISOLATED,
      "--judge-harness",
      "codex",
    ],
    { SKILL_EVALS_BIN_CODEX: box.pi },
  );
  expect(result.status).toBe(2);
  expect(result.stderr).toMatch(
    /--isolated cannot run with the judge harness codex:/,
  );
  expect(fs.existsSync(box.started)).toBe(false);
});

test("a harness needs both isolated and loadedReport to run under --isolated", () => {
  const harness = (...caps: string[]) => ({
    harness: { id: "x", capabilities: new Set(caps) } as never,
    bin: "x",
  });
  const run =
    (...caps: string[]) =>
    () => {
      requireIsolation([harness(...caps)]);
    };
  expect(run("isolated", "loadedReport")).not.toThrow();
  expect(run("isolated")).toThrow(/cannot run/);
  expect(run("loadedReport")).toThrow(/cannot run/);
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
  expect(result.status).toBe(EXIT.invalid);
  expect(result.stdout).toMatch(/loaded outside the subject/);
});
