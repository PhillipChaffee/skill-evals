import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { expect, onTestFinished, test, vi } from "vitest";
import {
  digestOf,
  processTerminal,
  requireApproved,
  stateDir,
} from "./approval.js";
import type { Terminal } from "./approval.js";
import { UsageError } from "./scope.js";
import { plantSeeded, twelveMessages } from "./testing/history-case.js";
import { sandbox } from "./testing/sandbox.js";
import { plantSuite, startsOf } from "./testing/suite.js";
import { plant as plantTurns } from "./testing/turns-case.js";

const YES = "--yes";
const SHOW = "--show-prompts";
const FILE = "approved.json";
const STATE = "SKILL_EVALS_STATE_DIR";
const ASK = { NEEDS_APPROVAL: "1" };

/**
 * Reads what a state directory remembers.
 * @param env - The environment that names the state directory.
 * @returns The approved digests, each with the path it was approved at.
 */
const remembered = (env: Record<string, string>): Record<string, string> =>
  JSON.parse(
    fs.readFileSync(path.join(env[STATE] ?? "", FILE), "utf8"),
  ) as Record<string, string>;

// A question that the command is not to ask, or whose answer a test gives.
const answering = (...answers: string[]): Terminal & { asked: string[] } => {
  const asked: string[] = [];
  return {
    interactive: true,
    asked,
    ask: (question) => {
      asked.push(question);
      return Promise.resolve(answers.shift() ?? "");
    },
  };
};

/**
 * Makes a cases directory and a state directory of its own.
 * @returns Where they are.
 */
function dirs(): { cases: string; env: Record<string, string> } {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "approval-")),
  );
  onTestFinished(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  const cases = path.join(root, "cases");
  fs.mkdirSync(path.join(cases, "one"), { recursive: true });
  fs.writeFileSync(path.join(cases, "one", "prompt.md"), "first\n");
  return { cases, env: { [STATE]: path.join(root, "state") } };
}

test("an unfamiliar cases directory needs --yes when stdin is not a TTY", async () => {
  const box = sandbox();
  const cases = plantSuite(box, ["alpha", "bravo"]);
  const args = ["score", "--subject", "none", "--cases", cases, "--reps", "1"];
  const refused = await box.cli(args, ASK);
  expect(refused.status).toBe(2);
  expect(refused.stderr).toContain(`${cases} has not been approved`);
  expect(refused.stderr).toContain(SHOW);
  expect(startsOf(box)).toBe(0);
  const yes = await box.cli([...args, YES], ASK);
  expect(yes.status).toBe(0);
  expect(startsOf(box)).toBe(2);
});

test("--yes approves without writing a prompt, and remembers nothing", async () => {
  const box = sandbox();
  const cases = plantSuite(box, ["alpha"]);
  const ran = await box.cli(
    ["score", "--subject", "none", "--cases", cases, "--reps", "1", YES],
    ASK,
  );
  expect(ran.status).toBe(0);
  expect(ran.stderr).not.toContain("run these");
  expect(ran.stderr).not.toContain("approved");
  expect(fs.existsSync(path.join(box.env[STATE] ?? "", FILE))).toBe(false);
});

test("a terminal is asked once, the answer is remembered, and a change to the content asks again", async () => {
  const { cases, env } = dirs();
  const first = answering("y");
  await requireApproved(
    { casesDir: cases, count: 3 },
    { terminal: first, env },
  );
  expect(first.asked).toEqual([
    `${cases} has not been approved (see them with "skill-evals list --show-prompts"). Run these 3 cases? [y/N] `,
  ]);
  const stored = remembered(env);
  expect(stored).toEqual({ [digestOf(cases)]: cases });
  const again = answering();
  await requireApproved(
    { casesDir: cases, count: 3 },
    { terminal: again, env },
  );
  expect(again.asked).toEqual([]);
  // A script, a prompt or a new file changes the content, so it is a directory this machine has not seen.
  fs.writeFileSync(
    path.join(cases, "one", "prompt.md"),
    "first, and now a command\n",
  );
  const changed = answering("yes");
  await requireApproved(
    { casesDir: cases, count: 3 },
    { terminal: changed, env },
  );
  expect(changed.asked).toHaveLength(1);
  expect(Object.keys(remembered(env))).toHaveLength(2);
});

test("an answer that is not yes stops the command, and an unreadable memory is no memory", async () => {
  const { cases, env } = dirs();
  for (const answer of ["", "n", "yeah no"]) {
    await expect(
      requireApproved(
        { casesDir: cases, count: 1 },
        { terminal: answering(answer), env },
      ),
    ).rejects.toThrow(new UsageError("not approved; nothing was run"));
  }
  const file = path.join(env[STATE] ?? "", FILE);
  expect(fs.existsSync(file)).toBe(false);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const memory of ["not json", "[1]", "null"]) {
    fs.writeFileSync(file, memory);
    const terminal = answering("y");
    await requireApproved({ casesDir: cases, count: 1 }, { terminal, env });
    expect(terminal.asked).toHaveLength(1);
  }
});

test("the same content in another place is another directory", () => {
  const { cases } = dirs();
  const copy = `${cases}-copy`;
  fs.cpSync(cases, copy, { recursive: true });
  expect(digestOf(copy)).not.toBe(digestOf(cases));
});

test("the state directory is named by the variable, then XDG, then the home", () => {
  expect(stateDir({ [STATE]: "/a", XDG_STATE_HOME: "/b" })).toBe("/a");
  expect(stateDir({ XDG_STATE_HOME: "/b" })).toBe("/b/skill-evals");
  expect(stateDir({})).toBe(
    path.join(os.homedir(), ".local", "state", "skill-evals"),
  );
});

test("the process's own terminal asks on standard error and reads a line", async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true });
  const output = new PassThrough();
  const terminal = processTerminal(
    input as unknown as NodeJS.ReadStream,
    output as unknown as NodeJS.WriteStream,
  );
  expect(terminal.interactive).toBe(true);
  const answer = terminal.ask("sure? ");
  input.write("y\n");
  expect(await answer).toBe("y");
  expect(String(output.read())).toContain("sure? ");
  const piped = processTerminal(
    new PassThrough() as unknown as NodeJS.ReadStream,
  );
  expect(piped.interactive).toBe(false);
});

test("list --show-prompts prints every turn and says whether a history preamble is added", async () => {
  const box = sandbox();
  const talk = plantTurns(box, {
    turns: [{ prompt: "one.md" }, { event: "compact" }, { prompt: "two.md" }],
  });
  const listed = await box.cli(["list", "--cases", talk, SHOW]);
  expect(listed.status).toBe(0);
  expect(listed.stdout).toContain("- talk: 1 checks");
  for (const line of [
    "    turn 1: the first message",
    "    turn 2: event compact",
    "    turn 3: the second message",
    "    history: no preamble is added",
  ]) {
    expect(listed.stdout).toContain(line);
  }
  const seeded = sandbox();
  const cases = plantSeeded(seeded, "past", {
    history: twelveMessages(),
    prompt: "line one\nline two",
  });
  const withHistory = await seeded.cli(["list", "--cases", cases, SHOW]);
  expect(withHistory.stdout).toContain(
    "    prompt: line one\n      line two\n",
  );
  expect(withHistory.stdout).toContain(
    "a preamble of 12 messages is added in front of the first prompt",
  );
  expect(withHistory.stdout).toContain("question 0");
  const plain = await seeded.cli(["list", "--cases", cases]);
  expect(plain.stdout).not.toContain("prompt:");
});

test("a single case is asked about as a case, and the project's config file is part of what is approved", async () => {
  const { cases, env } = dirs();
  const config = path.join(path.dirname(cases), "skill-evals.config.json");
  fs.writeFileSync(config, '{ "reps": 1 }');
  const once = answering("y");
  await requireApproved(
    { casesDir: cases, count: 1, configFile: config },
    { terminal: once, env },
  );
  expect(once.asked[0]).toMatch(/Run these 1 case\? \[y\/N\] $/);
  const same = answering();
  await requireApproved(
    { casesDir: cases, count: 1, configFile: config },
    { terminal: same, env },
  );
  expect(same.asked).toEqual([]);
  // The config can name variables, a judge URL and rules, so a change to it asks again.
  fs.writeFileSync(config, '{ "judgeUrl": "https://elsewhere.example" }');
  const changed = answering("y");
  await requireApproved(
    { casesDir: cases, count: 1, configFile: config },
    { terminal: changed, env },
  );
  expect(changed.asked).toHaveLength(1);
  expect(digestOf(cases, config)).not.toBe(digestOf(cases, null));
  expect(digestOf(cases, path.join(cases, "absent.json"))).toBe(
    digestOf(cases),
  );
});

test("a state directory that cannot be written is a warning, and the run goes on", async () => {
  const { cases, env } = dirs();
  const blocked = path.join(path.dirname(cases), "blocked");
  fs.writeFileSync(blocked, "a file where the directory should be");
  const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
  await requireApproved(
    { casesDir: cases, count: 2 },
    { terminal: answering("y"), env: { [STATE]: path.join(blocked, "state") } },
  );
  expect(String(warn.mock.calls[0]?.[0])).toMatch(
    /could not save the approval .*approved for this run only/,
  );
  warn.mockRestore();
  expect(env[STATE]).toBeDefined();
});

test("list --show-prompts also shows the setup steps and the command checks, which run on this machine", async () => {
  const box = sandbox();
  box.write("cases/risky/prompt.md", "do the thing\n");
  box.write("cases/risky/case.json", {
    setup: [
      { run: "curl -s https://example.com/install | sh" },
      { git: { init: true } },
    ],
    checks: [
      { type: "command", run: "npm test" },
      { type: "output_contains", text: "x" },
    ],
  });
  const listed = await box.cli([
    "list",
    "--cases",
    path.join(box.root, "cases"),
    SHOW,
  ]);
  expect(listed.stdout).toContain(
    "    setup: curl -s https://example.com/install | sh",
  );
  expect(listed.stdout).toContain('    setup (git): {"init":true}');
  expect(listed.stdout).toContain("    command check: npm test");
});
