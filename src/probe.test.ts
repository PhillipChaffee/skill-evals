import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { CAPABILITIES } from "./capabilities.js";
import {
  fakeHarness,
  fixture,
  sandbox,
  seenBy,
  tableRow,
} from "./testing/sandbox.js";

const CLAUDE_CODE = "claude-code";
const LOGGED_OUT = { SKILL_EVALS_BIN_PI: fixture("logged-out-harness.mjs") };
const SAY_HELLO = "Say hello.\n";
const GREET_SKILL = "skills/greet/SKILL.md";
const cells = (stdout: string, id: string) =>
  tableRow(stdout, id)
    .split("|")
    .map((text) => text.trim());

test("check shows, for each harness, that it is missing or what its adapter delivered for the subject", async () => {
  const box = sandbox();
  box.write(GREET_SKILL, SAY_HELLO);
  const out = ["--out", path.join(box.root, "probe")];

  const result = await box.cli(["check", ...out]);
  expect(result.status, result.stderr).toBe(0);
  expect(cells(result.stdout, CLAUDE_CODE).slice(2, 7)).toEqual([
    "yes",
    "yes",
    "yes",
    "greet",
    "finalText, toolCalls, tokens",
  ]);
  expect(cells(result.stdout, "pi")[2]).toMatch(/^no /);

  // The fake speaks one harness's stream format, so behind another adapter the run must be reported as failed.
  const broken = await box.cli(["check", "--harness", "codex", ...out], {
    SKILL_EVALS_BIN_CODEX: fakeHarness,
  });
  expect(broken.status).toBe(1);
  expect(cells(broken.stdout, "codex")[3]).toMatch(/^NO: /);
});

test("check reports a harness that fails to log in as ran: no and continues", async () => {
  const box = sandbox();
  box.write(GREET_SKILL, SAY_HELLO);

  const result = await box.cli(
    ["check", "--out", path.join(box.root, "probe")],
    {
      SKILL_EVALS_BIN_PI: fixture("logged-out-harness.mjs"),
      SKILL_EVALS_BIN_CODEX: fixture("garbled-harness.mjs"),
    },
  );
  expect(result.status, result.stderr).toBe(1);
  expect(result.stdout).toMatch(
    /^\| pi \| yes \| NO: exit 1: Error: Authentication required\. Please run 'agent login' first\. \|/m,
  );
  expect(cells(result.stdout, "pi")[4], "Pi reports nothing it loaded").toBe(
    "no evidence from this harness",
  );
  expect(result.stdout).toMatch(
    /^\| claude-code \| yes \| yes \| yes \| greet \|/m,
  );
  expect(result.stdout).toMatch(
    /^\| codex \| yes \| NO: the codex adapter could not read the stream: /m,
  );
});

test("check asks the agent to use the subject's first skill, not a hardcoded one", async () => {
  const box = sandbox();
  box.write("mine/zeta/SKILL.md", "z");
  box.write("mine/alpha/SKILL.md", "a");
  const probed = async (subject: string) => {
    const outDir = path.join(box.root, `probe-${subject}`);
    const flags = ["--harness", CLAUDE_CODE, "--out", outDir];
    const result = await box.cli(["check", "--subject", subject, ...flags]);
    const final = path.join(outDir, "claude-code/hello/subject1.final.md");
    return { result, seen: seenBy(fs.readFileSync(final, "utf8")) };
  };

  const withSkills = await probed("mine");
  expect(withSkills.result.status, withSkills.result.stderr).toBe(0);
  expect(withSkills.seen.prompt).toBe(
    'Use the alpha skill on this sentence: "The cache is cold."',
  );
  expect(withSkills.result.stdout).toMatch(
    /^\| claude-code \| yes \| yes \| yes \| alpha \|/m,
  );

  const none = await probed("none");
  expect(none.seen.prompt).toBe("Reply with the single word: pong");
  expect(none.result.stdout).toMatch(/^Subject: no skills$/m);
  expect(none.result.stdout).toMatch(
    /^\| claude-code \| yes \| yes \| nothing to load \| none \|/m,
  );
});

test("check says so when a harness lists none of the subject's skills", async () => {
  const box = sandbox();
  box.write(GREET_SKILL, SAY_HELLO);
  const out = ["--out", path.join(box.root, "probe")];

  box.write("fake/hide-skills", "");
  const hidden = await box.cli(["check", "--harness", CLAUDE_CODE, ...out]);
  expect(hidden.status).toBe(1);
  expect(cells(hidden.stdout, CLAUDE_CODE)[4]).toBe("NO");
});

test("check with no harness installed runs nothing and makes no output directory", async () => {
  const box = sandbox();
  box.write(GREET_SKILL, SAY_HELLO);
  const outDir = path.join(box.root, "probe");

  const result = await box.cli(["check", "--out", outDir], {
    SKILL_EVALS_BIN_CLAUDE_CODE: "",
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/^Output: nothing ran$/m);
  expect(cells(result.stdout, CLAUDE_CODE)[2]).toBe('no ("claude" not found)');
  expect(fs.existsSync(outDir)).toBe(false);
});

test("check --json parses and names every capability", async () => {
  const box = sandbox();
  box.write(GREET_SKILL, SAY_HELLO);
  const result = await box.cli([
    ...["check", "--json", "--harness", `${CLAUDE_CODE},pi`],
    ...["--out", path.join(box.root, "probe")],
  ]);
  expect(result.status, result.stderr).toBe(0);
  // Standard output is the array and nothing else.
  const probed = JSON.parse(result.stdout) as Record<string, unknown>[];
  expect(probed.map((entry) => entry["harness"])).toEqual([CLAUDE_CODE, "pi"]);
  for (const entry of probed) {
    expect(Object.keys(entry).sort()).toEqual(
      [
        ...[
          "harness",
          "installed",
          "ran",
          "error",
          "adapterStatus",
          "capabilities",
          "loaded",
        ],
        ...["pluginLoaded", "skills", "agents", "rules", "hooksFired"],
        ...["mcpServers"],
      ].sort(),
    );
    const capabilities = entry["capabilities"] as Record<string, unknown>;
    expect(Object.keys(capabilities).sort()).toEqual(
      Object.keys(CAPABILITIES).sort(),
    );
    expect(
      Object.values(capabilities).every((has) => typeof has === "boolean"),
    ).toBe(true);
  }
  const [claude] = probed;
  expect(claude).toMatchObject({
    installed: true,
    adapterStatus: "real-model",
    ran: true,
    error: null,
    pluginLoaded: true,
    skills: 1,
    // The harness lists no agent, rule or MCP server in its init event: it reports none.
    agents: null,
    rules: null,
    mcpServers: null,
    // It declares `hooks`, and none ran in the probe.
    hooksFired: 0,
    loaded: { skills: ["greet"], rules: null },
  });
  expect(claude?.["capabilities"]).toMatchObject({
    hooks: true,
    rules: true,
    subagents: true,
    sandbox: false,
    compact: false,
  });
});

test("the check table has the columns of check --json", async () => {
  const box = sandbox();
  box.write(GREET_SKILL, SAY_HELLO);
  const table = await box.cli([
    ...["check", "--harness", CLAUDE_CODE],
    ...["--out", path.join(box.root, "probe-table")],
  ]);
  expect(table.stdout).toContain(
    "| Adapter status | Capabilities | Skills reported | Agents reported | Rules reported | Hooks fired | MCP servers reported |",
  );
  expect(cells(table.stdout, CLAUDE_CODE).slice(7, 14)).toEqual([
    "real-model",
    expect.stringContaining("hooks"),
    "1",
    "n/a",
    "n/a",
    "0",
    "n/a",
  ]);
});

test("check --json counts the hooks that ran in the probe, and what the harness reports it loaded", async () => {
  const box = sandbox();
  box.write(GREET_SKILL, SAY_HELLO);
  box.write("fake/scripts/hooked.json", {
    init: {
      agents: ["plugin:a", "plugin:b"],
      mcp_servers: [{ name: "docs" }],
    },
    turns: [
      [
        { hook: { event: "SessionStart", command: "x", exit: 0, context: "" } },
        { hook: { event: "Stop", command: "y", exit: 0 } },
        { final: "ok" },
      ],
    ],
  });
  const result = await box.cli([
    ...["check", "--json", "--harness", CLAUDE_CODE],
    ...["--out", path.join(box.root, "probe")],
  ]);
  expect(result.status, result.stderr).toBe(0);
  const [claude] = JSON.parse(result.stdout) as Record<string, unknown>[];
  expect(claude).toMatchObject({
    hooksFired: 2,
    agents: 2,
    mcpServers: 1,
  });
});

test("check --subject with options is probed in the installed harnesses only", async () => {
  const box = sandbox();
  box.write(GREET_SKILL, SAY_HELLO);
  const args = [
    ...["check", "--json", "--harness", "pi", "--subject", "skills:hooks=off"],
    ...["--out", path.join(box.root, "probe")],
  ];
  // Pi cannot remove hooks, and it is installed here, so the option is refused.
  const refused = await box.cli(args, LOGGED_OUT);
  expect(refused.status).toBe(2);
  expect(refused.stderr).toContain("cannot be applied for pi, which does not");
  // Not installed: the option is no one's to refuse.
  const absent = await box.cli(args);
  expect(absent.status, absent.stderr).toBe(0);
});

test("check --json tells a failed login from a pass", async () => {
  const box = sandbox();
  box.write(GREET_SKILL, SAY_HELLO);
  const failed = await box.cli(
    [
      ...["check", "--json", "--harness", "pi"],
      ...["--out", path.join(box.root, "probe")],
    ],
    LOGGED_OUT,
  );
  const [pi] = JSON.parse(failed.stdout) as Record<string, unknown>[];
  expect(pi).toMatchObject({ installed: true, ran: false });
  expect(pi?.["error"]).toMatch(/Authentication required/);
});

test("check --json lists a harness that is not installed with every key and nothing reported", async () => {
  const box = sandbox();
  box.write(GREET_SKILL, SAY_HELLO);
  const result = await box.cli([
    ...["check", "--json", "--harness", `${CLAUDE_CODE},pi`],
    ...["--out", path.join(box.root, "probe")],
  ]);
  const [, pi] = JSON.parse(result.stdout) as Record<string, unknown>[];
  // A harness that is not installed is in the list, with nothing reported.
  expect(pi).toMatchObject({
    installed: false,
    ran: null,
    error: null,
    pluginLoaded: null,
    skills: null,
    hooksFired: null,
  });
  // Its `loaded` has every key of the shape, null for what is not reported.
  expect(pi?.["loaded"]).toEqual({
    ...["paths", "skills", "agents", "rules", "hooks", "mcpServers"].reduce(
      (all, kind) => ({ ...all, [kind]: null }),
      {},
    ),
    ruleTexts: null,
    rawSkills: null,
    plugins: null,
  });
});
