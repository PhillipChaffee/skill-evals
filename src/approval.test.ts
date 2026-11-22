import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { expect, onTestFinished, test } from "vitest";
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
  expect(first.asked).toEqual(["run these 3 cases? [y/N] "]);
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
  const plain = await seeded.cli(["list", "--cases", cases]);
  expect(plain.stdout).not.toContain("prompt:");
});
