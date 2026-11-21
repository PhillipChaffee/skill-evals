import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import {
  fakeHarness,
  fixture,
  sandbox,
  seenBy,
  tableRow,
} from "./testing/sandbox.js";

const CLAUDE_CODE = "claude-code";
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

  const hidden = await box.cli(["check", "--harness", CLAUDE_CODE, ...out], {
    FAKE_HIDE_SKILLS: "1",
  });
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
