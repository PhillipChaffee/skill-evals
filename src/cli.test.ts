import { expect, test } from "vitest";
import { COMMANDS } from "./cli.js";
import { sandbox } from "./testing/sandbox.js";
import { commandUsage } from "./usage.js";

const USAGE_ERROR = 2;

test("--help exits 0 and prints the command table on stdout", async () => {
  const box = sandbox();
  for (const args of [["--help"], ["help"]]) {
    const result = await box.cli(args);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    for (const [name, command] of Object.entries(COMMANDS)) {
      expect(result.stdout).toContain(name);
      expect(result.stdout).toContain(command.description);
    }
  }
});

test("score --help lists --subject and not --a, and ends with the subject and config footer", async () => {
  const box = sandbox();
  const result = await box.cli(["score", "--help"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/^ {2}--subject <subject>/m);
  expect(result.stdout).not.toMatch(/--a <subject>/);
  expect(result.stdout).toContain("default: the project");
  expect(result.stdout).toContain("A subject is what a run loads");
  expect(result.stdout).toContain("skill-evals.config.json");
  expect((await box.cli(["help", "score"])).stdout).toBe(result.stdout);
  expect(result.stdout).toBe(`${commandUsage("score", COMMANDS)}\n`);
});

test("--help wins over missing values and other flags, for every command", async () => {
  const box = sandbox();
  for (const name of Object.keys(COMMANDS)) {
    for (const args of [
      [name, "--help"],
      [name, "--model", "--help"],
      [name, "--nonsense", "--help"],
    ]) {
      const result = await box.cli(args);
      expect(result.status, args.join(" ")).toBe(0);
      expect(result.stdout).toContain(`Usage: skill-evals ${name}`);
    }
  }
});

test("help --help exits 0", async () => {
  const result = await sandbox().cli(["help", "--help"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("Usage: skill-evals <command>");
});

test("help of an unknown command exits 2; a bare command line and an unknown command keep their usage errors", async () => {
  const box = sandbox();
  const unknown = await box.cli(["help", "frobnicate"]);
  expect(unknown.status).toBe(USAGE_ERROR);
  expect(unknown.stdout).toBe("");
  expect(unknown.stderr).toMatch(/unknown command "frobnicate"/);
  const bare = await box.cli([]);
  expect(bare.status).toBe(USAGE_ERROR);
  expect(bare.stdout).toBe("");
  expect(bare.stderr).toMatch(/^skill-evals: missing command\n\nUsage: /);
  const other = await box.cli(["frobnicate", "--help"]);
  expect(other.status).toBe(USAGE_ERROR);
  expect(other.stderr).toMatch(/unknown command "frobnicate"/);
});
