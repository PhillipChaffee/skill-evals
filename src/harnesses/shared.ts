import fs from "node:fs";
import path from "node:path";
import type { Capability } from "../capabilities.js";
import type { Subject } from "../subject.js";

// Every tool kind with what it means. The docs list the kinds from this table.
export const TOOL_KIND_MEANINGS = {
  shell: "Ran a command.",
  read: "Read a file.",
  write: "Created or replaced a file.",
  edit: "Changed part of a file, or deleted one.",
  search: "Searched or listed files.",
  web: "Fetched a page or searched the web.",
  skill: "Called the harness's skill tool.",
  subagent: "Started another agent.",
  other: "Any tool the harness's adapter has no kind for, such as an MCP tool.",
} as const;

/** What a tool does, the same word in every harness. */
export type ToolKind = keyof typeof TOOL_KIND_MEANINGS;

// The table's keys are exactly the kinds, so the cast only names them.
export const TOOL_KINDS = Object.keys(TOOL_KIND_MEANINGS) as ToolKind[];

/** One tool call of the agent. */
export interface ToolCall {
  /** The harness's own tool name. */
  name: string;
  kind: ToolKind;
  input: unknown;
  /** The call's position in the run's list, from 0. Set once, after parsing; an adapter never sets it, and a 0.0.1 record lacks it. */
  index?: number;
  /** The assistant turn that issued the call, counted from 1. Only an adapter with the `turnGrouping` capability sets it. */
  turn?: number;
  /** The agent that made the call (depth 0 is the main agent, id `main`). Absent until the harness attributes calls to agents; absent means the main agent. */
  agent?: { id: string; type: string; parent: string | null; depth: number };
}

/** Token counts; input counts every prompt token, cached ones included. */
export interface Tokens {
  input: number;
  output: number;
}

/** What a harness says it loaded at startup. Null means the harness does not report that kind of thing. */
export interface Loaded {
  /** The directories of its plugins. */
  paths: string[] | null;
  /** The names of its skills, without any plugin prefix. */
  skills: string[] | null;
  agents: string[] | null;
  rules: string[] | null;
  hooks: string[] | null;
  mcpServers: string[] | null;
  /** The skill names as the harness listed them, with any plugin prefix, for an adapter that has one. */
  rawSkills?: string[] | null;
  /** The plugins with their names, for an adapter that reports them. */
  plugins?: { name: string; path: string }[] | null;
}

/** What a harness that reports nothing about its startup gives. */
export const NOT_REPORTED: Loaded = {
  paths: null,
  skills: null,
  agents: null,
  rules: null,
  hooks: null,
  mcpServers: null,
};

/** A harness's output stream in the one shape every harness shares. Null means the harness does not report the field. */
export interface Parsed {
  finalText: string;
  toolCalls: ToolCall[];
  tokens: Tokens | null;
  costUsd: number | null;
  /** What the harness says it loaded at startup: its plugin directories, skills, agents, rules, hooks and MCP servers. */
  loaded: Loaded;
  error: string | null;
}

/** How to start a harness for one prompt. */
export interface Invocation {
  args: string[];
  env: Record<string, string>;
  /** Argument vectors to run with the same binary and environment before the prompt. */
  setup?: string[][];
  /** Written to the harness's standard input, for a harness that takes its prompt there. */
  stdin?: string;
  /** Where the adapter placed each skill of a skills subject: skill name to directory. The run watches them. */
  placed?: Record<string, string>;
}

/** A plugin or a skills folder: a subject that puts something into the harness. */
export type LoadedSubject = Pick<Subject, "skills" | "skillDirs"> & {
  kind: "plugin" | "skills";
  dir: string;
  /** The plugin's own name, which prefixes its skills in the skill tool. Absent or null: no name is known. */
  pluginName?: string | null;
};

/** What an adapter gets to build an invocation from. */
export interface RunInput {
  /** Null loads nothing. */
  subject: LoadedSubject | null;
  /** The run's throwaway HOME, with the XDG directories at their defaults under it. */
  home: string;
  workspace: string;
  prompt: string;
  model?: string | undefined;
  maxTurns?: number | undefined;
  /** Start with nothing loaded but the subject. Only an adapter with the `isolated` capability is given true. */
  isolated?: boolean | undefined;
}

/** The variables that log in to Anthropic's API, to Bedrock and to Vertex. Names are exact, never a prefix. */
export const ANTHROPIC_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "AWS_REGION",
  "AWS_PROFILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
];

/** The variables that log in to OpenAI's API. */
export const OPENAI_ENV = ["OPENAI_API_KEY", "OPENAI_BASE_URL"];

/** The adapter of one coding-agent CLI. */
export interface Harness {
  id: string;
  /** The name of the executable on PATH. */
  bin: string;
  /** Login files to copy into the throwaway home, relative to the user's home. */
  authFiles: string[];
  /** Variables of the user's environment that carry the harness's login or choose its provider; they reach it by name. */
  authEnv: string[];
  /** What the adapter can observe or do, each proven by a parser test on a stream. A case that needs more is not applicable. */
  capabilities: ReadonlySet<Capability>;
  /** How far the adapter is proven: a real model ran, a scripted endpoint ran, or neither (see agents/verified). */
  status: "real-model" | "scripted" | "unverified";
  invocation: (input: RunInput) => Invocation;
  /**
   * The file that a read-kind call targets, so that path extraction stays in the adapter.
   * @returns The path as the agent wrote it, which may be relative to the workspace; null for a call that names none,
   *   and for every call of a harness that has no read kind.
   */
  pathOf: (call: ToolCall) => string | null;
  /**
   * The skill that a skill-kind call names, with any plugin prefix still on it. Absent: the first string among the
   * arguments `skill`, `name` and `id`.
   */
  skillOf?: (call: ToolCall) => string | null;
  /**
   * Finds the skill copies that the harness itself made during setup, which `invocation` could not place because they
   * do not exist until the setup steps have run. Called after them and before the prompt.
   * @returns Skill name to the directory of its copy, with none for a missing one. The run adds them to `placed`.
   */
  placedAfterSetup?: (input: RunInput) => Record<string, string>;
  /** May throw on a stream it does not understand; the caller reports that as a failed run. */
  parse: (stdout: string) => Parsed;
  /**
   * Names what the harness reported that does not come from the subject, for a harness whose report needs more than
   * the shared rule. Absent: `foreignDefault`.
   */
  foreign?: (loaded: Loaded, subject: LoadedSubject | null) => string[];
  /**
   * How the adapter isolates a run, for an adapter with the `isolated` capability. `invocation` uses these same
   * `args` and `env` when the run is isolated.
   */
  isolation?: Isolation;
  /** Why a harness without `isolation` cannot run `--isolated`, for the docs. */
  isolationGap?: string;
  /**
   * Names what a finished run left in the run's home that the run did not place, such as skills the account synced
   * there. The report of what loaded does not show them. Called while the home still exists.
   */
  strays?: (run: {
    home: string;
    placed: Record<string, string> | undefined;
  }) => string[];
}

/** The switches that make a harness load nothing but the subject, and what the run record proves of that. */
export interface Isolation {
  /** Command-line arguments added when the run is isolated. */
  args: string[];
  /** Environment variables added when the run is isolated. */
  env: Record<string, string>;
  /** What the report of what loaded covers. */
  proves: string;
  /** What no switch removes and the report does not show. */
  notProven: string;
  /** Markdown bullet list of what the switches do and what was read in the CLI, for the docs. */
  notes: string;
}

/**
 * Tells whether a harness that should report what it loaded left out plugins or skills.
 * @param harness - The adapter.
 * @param loaded - What it reported.
 * @returns True for a harness with `loadedReport` whose plugins or skills are null. Such a report proves nothing.
 */
export const reportMissing = (
  harness: Pick<Harness, "capabilities">,
  loaded: Loaded,
): boolean =>
  harness.capabilities.has("loadedReport") &&
  (loaded.paths === null || loaded.skills === null);

/**
 * Compares two paths that may reach one directory through different symlinks.
 * @param x - A path, which need not exist.
 * @param y - Another path.
 * @returns True when both resolve to the same real path.
 */
export function samePath(x: string, y: string): boolean {
  const real = (p: string): string => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(x) === real(y);
}

/**
 * Lists the reported plugin paths that are not the subject's copy.
 * @param loaded - What the harness reported.
 * @param subject - What the run loaded.
 * @returns The paths, as reported. Only a plugin subject has a path of its own.
 */
export const foreignPaths = (
  loaded: Loaded,
  subject: LoadedSubject | null,
): string[] =>
  (loaded.paths ?? []).filter(
    (reported) =>
      !(subject?.kind === "plugin" && samePath(reported, subject.dir)),
  );

/**
 * The shared rule for what is not the subject's: every reported plugin path, skill, agent, MCP server and hook that the
 * subject does not own. A subject owns its copy's path and the skills it lists, and nothing else is known to be its own.
 * @param loaded - What the harness reported.
 * @param subject - What the run loaded; null loads nothing.
 * @returns Human-readable names, in the order paths, skills, agents, MCP servers, hooks.
 */
function foreignDefault(
  loaded: Loaded,
  subject: LoadedSubject | null,
): string[] {
  const own = new Set(subject?.skills);
  return [
    ...foreignPaths(loaded, subject),
    ...(loaded.skills ?? [])
      .filter((name) => !own.has(name))
      .map((name) => `skill ${name}`),
    ...(loaded.agents ?? []).map((name) => `agent ${name}`),
    ...(loaded.mcpServers ?? []).map((name) => `MCP server ${name}`),
    ...(loaded.hooks ?? []).map((name) => `hook ${name}`),
  ];
}

/**
 * Names what a harness reported that does not come from the subject.
 * @param harness - The adapter, which may have its own rule.
 * @param loaded - What the harness reported.
 * @param subject - What the run loaded; null loads nothing.
 * @returns Human-readable names; none when the harness reported nothing foreign, or nothing at all.
 */
export const foreignOf = (
  harness: Pick<Harness, "foreign">,
  loaded: Loaded,
  subject: LoadedSubject | null,
): string[] => (harness.foreign ?? foreignDefault)(loaded, subject);

/**
 * Reads one string argument of a call's input.
 * @param call - A tool call.
 * @param keys - The argument names the harness's tool may use, in order of preference.
 * @returns The first of them that holds a non-empty string; null when the input is no object or holds none.
 */
export function stringArg(call: ToolCall, keys: string[]): string | null {
  // Object() turns an input that is no object into one with none of the keys.
  const given = Object(call.input) as Record<string, unknown>;
  const value = keys
    .map((key) => given[key])
    .find((v) => typeof v === "string" && v !== "");
  return typeof value === "string" ? value : null;
}

/** The arguments in which a skill tool most often names its skill. */
const SKILL_ARGS = ["skill", "name", "id"];

/**
 * Reads the skill a skill-kind call names, for an adapter that has no `skillOf` of its own.
 * @param call - A tool call.
 * @returns The name as the call gave it, plugin prefix included; null when no argument holds one.
 */
export const skillNameArg = (call: ToolCall): string | null =>
  stringArg(call, SKILL_ARGS);

/**
 * Builds a ToolCall from an adapter's table of native tool name to kind.
 * @param kinds - The adapter's table.
 * @param name - The harness's own name of the tool.
 * @param input - The arguments of the call, in the harness's own shape.
 * @returns The call. A name the table lacks, an inherited property name included, has the kind "other".
 */
export const toolCall = (
  kinds: Record<string, ToolKind>,
  name: string,
  input: unknown,
): ToolCall => ({
  name,
  kind: (Object.hasOwn(kinds, name) ? kinds[name] : undefined) ?? "other",
  input,
});

/**
 * Numbers the calls of a run by their position in its list.
 * @param calls - The calls an adapter read, in the order they were made.
 * @returns The same calls, each with its `index`.
 */
export const withIndexes = (calls: ToolCall[]): ToolCall[] =>
  calls.map((call, index) => ({ ...call, index }));

/**
 * Reads a stream of one JSON object per line.
 * @param stdout - Everything the harness wrote to standard output.
 * @returns The objects, in order and unvalidated. A line that is not a JSON object is a log line, and is skipped.
 */
export function jsonLines(stdout: string): unknown[] {
  const events: unknown[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // A log line that happens to start with a brace; the stream itself is one object per line.
    }
  }
  return events;
}

/**
 * Picks the directory to hand to a harness's own plugin loader.
 * @param subject - What the run loads.
 * @returns The directory of a plugin subject, and null for every other subject.
 */
export const pluginDir = (subject: LoadedSubject | null): string | null =>
  subject?.kind === "plugin" ? subject.dir : null;

const NOT_SKILL_CONTENT = new Set([".git", "node_modules"]);

/**
 * Copies each skill of a skills subject to `<dir>/<name>/`, so the path the agent sees is inside the throwaway home.
 * @param subject - What the run loads. Nothing is copied for a plugin or for null.
 * @param dir - Where the harness discovers the skills of its user.
 * @returns The copies: skill name to the directory of its copy. The adapter reports them as `placed`.
 */
export function placeSkills(
  subject: LoadedSubject | null,
  dir: string,
): Record<string, string> {
  if (subject?.kind !== "skills") return {};
  return Object.fromEntries(
    Object.entries(subject.skillDirs).map(([name, source]) => {
      const target = path.join(dir, name);
      fs.cpSync(source, target, {
        recursive: true,
        dereference: true,
        filter: (file) => !NOT_SKILL_CONTENT.has(path.basename(file)),
      });
      return [name, target];
    }),
  );
}

/**
 * Builds the arguments of an optional command-line flag.
 * @param flag - The flag, as the harness spells it.
 * @param value - The flag's value.
 * @returns The flag and its value as text, or nothing when the value is null or undefined.
 */
export const opt = (
  flag: string,
  value: string | number | null | undefined,
): string[] => (value == null ? [] : [flag, String(value)]);

/**
 * Adds up the token counts of several turns.
 * @param usages - One count for each turn that reported one.
 * @returns The totals, or null when no turn reported a count.
 */
export function sumTokens(usages: Tokens[]): Tokens | null {
  if (usages.length === 0) return null;
  return usages.reduce(
    (total, u) => ({
      input: total.input + u.input,
      output: total.output + u.output,
    }),
    { input: 0, output: 0 },
  );
}
