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
}

/** Token counts; input counts every prompt token, cached ones included. */
export interface Tokens {
  input: number;
  output: number;
}

/** A harness's output stream in the one shape every harness shares. Null means the harness does not report the field. */
export interface Parsed {
  finalText: string;
  toolCalls: ToolCall[];
  tokens: Tokens | null;
  costUsd: number | null;
  /** What the harness says it loaded at startup: the directories of its plugins and the names of its skills. */
  loaded: { paths: string[] | null; skills: string[] | null };
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
  /** May throw on a stream it does not understand; the caller reports that as a failed run. */
  parse: (stdout: string) => Parsed;
}

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
