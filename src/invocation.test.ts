import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { HARNESSES, selectHarnesses } from "./harnesses/index.js";
import type {
  Invocation,
  LoadedSubject,
  RunInput,
} from "./harnesses/shared.js";
import { fakeHarness } from "./testing/sandbox.js";

const CLAUDE_CODE = "claude-code";
const PLUGIN_DIR = "--plugin-dir";

const only = (...ids: string[]) => ({
  PATH: "",
  ...Object.fromEntries(
    ids.map((id) => [
      `SKILL_EVALS_BIN_${id.toUpperCase().replace("-", "_")}`,
      fakeHarness,
    ]),
  ),
});
const chosen = (spec: string | undefined, env: Record<string, string>) =>
  selectHarnesses(spec, env).chosen.map(({ harness }) => harness.id);

test("the default harness is the first installed one in preference order", () => {
  expect(chosen(undefined, only("codex", "opencode"))).toEqual(["opencode"]);
  expect(chosen(undefined, only("codex", "cursor", CLAUDE_CODE))).toEqual([
    CLAUDE_CODE,
  ]);
  expect(chosen(undefined, only("codex", CLAUDE_CODE, "pi"))).toEqual(["pi"]);
  expect(chosen("all", only("codex", "pi"))).toEqual(["pi", "codex"]);
  expect(chosen("codex,pi", only("codex", "pi", "cursor"))).toEqual([
    "codex",
    "pi",
  ]);
  expect(() => chosen(undefined, only())).toThrow(/no harness is installed/);
  expect(() => chosen("cursor", only("pi"))).toThrow(/not installed/);
  expect(() => chosen("emacs", only("pi"))).toThrow(/unknown harness/);
});

test("a harness is found by its name on PATH, and a directory of that name is not one", () => {
  const dir = tempDir("path-");
  fs.mkdirSync(path.join(dir, "bin"));
  fs.symlinkSync(fakeHarness, path.join(dir, "bin/pi"));
  fs.mkdirSync(path.join(dir, "bin/codex"));
  const env = { PATH: ["", path.join(dir, "bin")].join(path.delimiter) };
  expect(chosen("all", env)).toEqual(["pi"]);
  expect(() => chosen("all", {})).toThrow(/no harness is installed/);
});

/**
 * Makes a temp directory that is removed when the test ends.
 * @param prefix - The start of its name.
 * @returns Its real path.
 */
function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  onTestFinished(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/**
 * Asks an adapter for its invocation, in a throwaway home.
 * @param id - The harness.
 * @param subject - What the run loads.
 * @param more - The prompt, when it is not "say hello", and options the adapter may turn into flags.
 * @returns The home and what the adapter built.
 */
function invoke(
  id: string,
  subject: LoadedSubject | null,
  more: Partial<
    Pick<RunInput, "prompt" | "model" | "maxTurns" | "isolated">
  > = {},
): Invocation & { home: string } {
  const home = tempDir("home-");
  const input = {
    subject,
    home,
    workspace: home,
    prompt: "say hello",
    ...more,
  };
  const harness = HARNESSES.find((candidate) => candidate.id === id);
  return { home, args: [], env: {}, ...harness?.invocation(input) };
}

/**
 * Makes a skills folder with the one skill `greet`, which also holds what a checkout leaves in a folder.
 * @returns A subject of kind "skills" whose directory is removed when the test ends.
 */
function skillsSubject(): LoadedSubject {
  const dir = tempDir("skills-");
  fs.mkdirSync(path.join(dir, "greet/.git"), { recursive: true });
  fs.writeFileSync(path.join(dir, "greet/.git/HEAD"), "ref");
  fs.writeFileSync(path.join(dir, "greet/SKILL.md"), "Say hello.\n");
  return {
    kind: "skills",
    dir,
    skills: ["greet"],
    skillDirs: { greet: path.join(dir, "greet") },
  };
}

// Where each harness discovers a skill of its user, relative to the home directory.
const SKILL_HOMES = [
  { id: CLAUDE_CODE, skillHome: ".claude/skills" },
  { id: "cursor", skillHome: ".cursor/skills" },
  { id: "codex", skillHome: ".agents/skills" },
  { id: "opencode", skillHome: ".agents/skills" },
  { id: "pi", skillHome: ".pi/agent/skills" },
];

test("every harness has a place where it discovers skills", () => {
  expect(SKILL_HOMES.map(({ id }) => id).sort()).toEqual(
    HARNESSES.map((harness) => harness.id).sort(),
  );
});

test.each(SKILL_HOMES)(
  "the $id adapter places a skills subject where its harness discovers skills",
  ({ id, skillHome }) => {
    const subject = skillsSubject();
    const { home, args } = invoke(id, subject);
    const copy = path.join(home, skillHome, "greet");
    expect(fs.readFileSync(path.join(copy, "SKILL.md"), "utf8")).toBe(
      "Say hello.\n",
    );
    expect(fs.lstatSync(copy).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(path.join(copy, ".git")), "repository data").toBe(
      false,
    );
    expect(args, "the folder itself").not.toContain(subject.dir);
  },
);

test("pi, which runs with skill discovery off, is told about each copy", () => {
  const pi = invoke("pi", skillsSubject());
  expect(pi.args[pi.args.indexOf("--skill") + 1]).toBe(
    path.join(pi.home, ".pi/agent/skills/greet"),
  );
});

// Codex installs a plugin from its marketplace file, which a bare directory lacks.
test.each(SKILL_HOMES.filter(({ id }) => id !== "codex"))(
  "the $id adapter places no skills for a plugin subject or for no subject",
  ({ id, skillHome }) => {
    const plugin: LoadedSubject = { ...skillsSubject(), kind: "plugin" };
    for (const subject of [plugin, null]) {
      const { home } = invoke(id, subject);
      expect(fs.existsSync(path.join(home, skillHome))).toBe(false);
    }
  },
);

test("each adapter that loads a plugin directory points its harness at it", () => {
  const plugin: LoadedSubject = { ...skillsSubject(), kind: "plugin" };
  const after = (id: string, flag: string) => {
    const { args } = invoke(id, plugin);
    return args[args.indexOf(flag) + 1];
  };
  expect(after(CLAUDE_CODE, PLUGIN_DIR)).toBe(plugin.dir);
  expect(after("cursor", PLUGIN_DIR)).toBe(plugin.dir);
  expect(after("pi", "-e")).toBe(plugin.dir);
  const { home } = invoke("opencode", plugin);
  const config = path.join(home, ".config/opencode/opencode.json");
  expect(JSON.parse(fs.readFileSync(config, "utf8"))).toEqual({
    plugin: [plugin.dir],
    plugins: [plugin.dir],
  });
});

test("codex installs a plugin from its marketplace file before the prompt", () => {
  const plugin: LoadedSubject = { ...skillsSubject(), kind: "plugin" };
  const marketplace = path.join(plugin.dir, ".agents/plugins/marketplace.json");
  fs.mkdirSync(path.dirname(marketplace), { recursive: true });
  fs.writeFileSync(
    marketplace,
    JSON.stringify({ name: "kit", plugins: [{ name: "magic" }] }),
  );
  expect(invoke("codex", plugin).setup).toEqual([
    ["plugin", "marketplace", "add", plugin.dir],
    ["plugin", "add", "magic@kit"],
  ]);
  expect(invoke("codex", null).setup).toEqual([]);
});

test("each adapter passes the model, and claude-code the turn limit, to its harness", () => {
  const flags = { [CLAUDE_CODE]: "--model", cursor: "--model", pi: "--model" };
  const short = { codex: "-m", opencode: "-m" };
  for (const [id, flag] of Object.entries({ ...flags, ...short })) {
    const { args } = invoke(id, null, { model: "some-model" });
    expect(args[args.indexOf(flag) + 1], id).toBe("some-model");
    expect(invoke(id, null).args, id).not.toContain(flag);
  }
  const limited = invoke(CLAUDE_CODE, null, { maxTurns: 3 }).args;
  expect(limited[limited.indexOf("--max-turns") + 1]).toBe("3");
});

test("each adapter keeps a prompt that starts with a dash as the prompt", () => {
  const prompt = "--help me";
  const placed = HARNESSES.map(({ id }) => {
    const { args, stdin } = invoke(id, null, { prompt });
    return stdin === undefined
      ? args.slice(-2)
      : [stdin, args.includes(prompt)];
  });
  const asArgument = ["--", prompt];
  const onStdin = [prompt, false];
  // Pi, the first harness, takes its prompt on standard input.
  expect(placed).toEqual([onStdin, ...Array<string[]>(4).fill(asArgument)]);
});

test("the claude-code invocation carries its isolation switches only when isolated", () => {
  const plain = invoke(CLAUDE_CODE, null);
  expect(plain.args).not.toContain("--setting-sources");
  expect(plain.args).not.toContain("--strict-mcp-config");
  expect(plain.env).not.toHaveProperty("CLAUDE_CODE_DISABLE_AUTO_MEMORY");
  const plugin: LoadedSubject = { ...skillsSubject(), kind: "plugin" };
  const { args, env } = invoke(CLAUDE_CODE, plugin, { isolated: true });
  // Only the user source, which is the throwaway home. Never --bare, which switches off the plugin's own hooks.
  expect(args[args.indexOf("--setting-sources") + 1]).toBe("user");
  expect(args).toContain("--strict-mcp-config");
  expect(args).not.toContain("--bare");
  expect(args[args.indexOf(PLUGIN_DIR) + 1]).toBe(plugin.dir);
  expect(env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"]).toBe("1");
  expect(args.at(-1)).toBe("say hello");
});

test("the invocation uses the adapter's own isolation description", () => {
  const claude = HARNESSES.find((h) => h.id === CLAUDE_CODE);
  const { args, env } = invoke(CLAUDE_CODE, null, { isolated: true });
  expect(claude?.isolation?.args.every((a) => args.includes(a))).toBe(true);
  expect(claude?.isolation?.env).toEqual({
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  });
  expect(env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"]).toBe("1");
});

test("a harness with the isolated capability describes its isolation", () => {
  for (const harness of HARNESSES) {
    expect(harness.capabilities.has("isolated"), harness.id).toBe(
      harness.isolation !== undefined,
    );
  }
});

test("pi, which is always started with discovery off, takes the same arguments isolated or not", () => {
  expect(invoke("pi", null, { isolated: true }).args).toEqual(
    invoke("pi", null).args,
  );
});
