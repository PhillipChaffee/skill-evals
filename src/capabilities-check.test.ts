import { expect, test } from "vitest";
import { sandbox, tableRow } from "./testing/sandbox.js";

const CLAUDE_CODE = "claude-code";
const MCP = "mcp";
const PROMPT_SEEN = { type: "output_contains", text: "prompt" };
const MISSING_BIN = "bin:definitely-missing";
const SKILLS_FILE = "skills/greet/SKILL.md";
const SAY_HELLO = "Say hello.\n";
const CASE_FILE = "evals/cases/a/case.json";

test("check prints each harness's capabilities and status, and the host set of the loaded cases", async () => {
  const none = sandbox();
  none.write(SKILLS_FILE, SAY_HELLO);
  const quiet = await none.cli(["check", "--harness", CLAUDE_CODE]);
  expect(quiet.stdout).toContain("Host capabilities: none requested");
  expect(quiet.stdout).toMatch(
    /- claude-code \(real-model\): subagents, turnGrouping, childCalls, childText, loadedReport, skillListing/,
  );
  expect(tableRow(quiet.stdout, CLAUDE_CODE)).toMatch(/^\| claude-code \| yes/);

  const box = sandbox();
  box.write(SKILLS_FILE, SAY_HELLO);
  box.write("evals/cases/a/prompt.md", "x\n");
  box.write(CASE_FILE, {
    requires: ["bin:git"],
    checks: [{ ...PROMPT_SEEN, requires: [MISSING_BIN] }],
  });
  const listed = await box.cli(["check", "--harness", CLAUDE_CODE]);
  expect(listed.stdout).toContain("Host capabilities: bin:git");
  expect(listed.stdout).not.toContain(MISSING_BIN);
});

test("check names what the host lacks, and survives a case file it cannot read", async () => {
  const box = sandbox();
  box.write(SKILLS_FILE, SAY_HELLO);
  box.write("evals/cases/a/prompt.md", "x\n");
  box.write(CASE_FILE, {
    requires: [MISSING_BIN],
    checks: [PROMPT_SEEN],
  });
  const absent = await box.cli(["check", "--harness", CLAUDE_CODE]);
  expect(absent.stdout).toContain(
    `Host capabilities: none present, of ${MISSING_BIN}`,
  );
  box.write(CASE_FILE, { checks: [], requires: [MCP] });
  const broken = await box.cli(["check", "--harness", CLAUDE_CODE]);
  expect(broken.status, broken.stderr).toBe(0);
  expect(broken.stdout).toMatch(/Host capabilities: cases not read \(.*checks/);
});
