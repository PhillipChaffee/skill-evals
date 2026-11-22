import fs from "node:fs";
import path from "node:path";
import type { Capability } from "../capabilities.js";
import type { HistoryAdapter } from "../history-types.js";
import type { Subject } from "../subject.js";
import type { SubjectOptions } from "../subject-options.js";
import type { HookEvent } from "./hook.js";
import type { Loaded } from "./loaded.js";
import type { RulesFile, RulesTarget } from "./rules.js";
import type { Invoke, TurnInput, TurnState } from "./turn-input.js";

export type { Invoke, LifecycleEvent, TurnState } from "./turn-input.js";
export { firstTurn } from "./turn-input.js";
export type { HookEvent } from "./hook.js";
export type { Loaded } from "./loaded.js";
export { NOT_REPORTED } from "./loaded.js";
export type { RulesFile, RulesTarget } from "./rules.js";

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
  question:
    "Asked the user a question, as Claude Code's `AskUserQuestion` does.",
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
  /** How long the call took, from its tool result, where the stream says. Only an adapter with the `toolDurations` capability sets it. */
  durationMs?: number;
  /** The user turn the call belongs to, counted from 1, in a case with `turns`. Absent for a single prompt. */
  userTurn?: number;
  /** The agent that made the call (depth 0 is the main agent, id `main`). Absent in a 0.0.1 record, which means the main agent. */
  agent?: AgentRef;
  /** What the dispatch asked for, on a `subagent` call; null in each field the harness's stream does not show. */
  dispatch?: Dispatch;
}

/** What a dispatch call chose for the agent it starts, as the adapter reads it from the call's input. */
export interface Dispatch {
  /** The agent type as the dispatch wrote it, with any plugin prefix; null when it names none. */
  type: string | null;
  model: string | null;
  effort: string | null;
}

/** What an adapter whose stream shows none of a dispatch's choices records. */
export const NO_DISPATCH: Dispatch = { type: null, model: null, effort: null };

/** Who produced an event. Depth 0 is the main agent, whose id is `main`. */
export interface AgentRef {
  id: string;
  type: string;
  parent: string | null;
  depth: number;
}

/** One step of a run, in the one shape every harness shares. */
export interface TranscriptEvent {
  /** The event's position in the run, from 0. */
  index: number;
  /** The assistant turn, counted from 1; null where the harness has no grouping. */
  turn: number | null;
  /** Which user turn this answers: from 1 in a case with `turns`, 0 for a single prompt. */
  userTurn: number;
  role: "user" | "assistant" | "tool" | "system";
  agent: AgentRef;
  type: "text" | "tool_call" | "tool_result" | "hook" | "lifecycle";
  /** Joins a `tool_call` to its `tool_result`. */
  callId?: string;
  kind?: ToolKind;
  name?: string;
  input?: unknown;
  /** What the dispatch chose, on a `tool_call` of kind `subagent` whose adapter reads it. */
  dispatch?: Dispatch;
  /** What the tool returned, on a `tool_result`, as decoded text. */
  output?: string;
  /** What the assistant said, on a `text`. */
  text?: string;
  /** The UTF-8 size of `text` or `output` as decoded, before any cut. Each invalid byte sequence was already replaced by one U+FFFD, which is three bytes. */
  bytes?: number;
  /** True when `text` or `output` was cut; `bytes` keeps the original size. */
  truncated?: boolean;
  /** On a `tool_result`: whether the harness marked the call as failed. */
  isError?: boolean;
  /** On a `tool_result`, where the stream says how long the call took. */
  durationMs?: number;
  /** On a `hook`: the hook that ran. A hook event is never a tool call, so no tool check counts it. */
  hook?: HookEvent;
}

/** Token counts; input counts every prompt token, cached ones included. */
export interface Tokens {
  input: number;
  output: number;
}

/** A harness's output stream in the one shape every harness shares. Null means the harness does not report the field. */
export interface Parsed {
  finalText: string;
  /** Always `callsOf(transcript)`: an adapter never builds it. */
  toolCalls: ToolCall[];
  /** Every text, tool call and tool result the stream shows, in order. */
  transcript: TranscriptEvent[];
  /** The harness's own id of the session, for a stream that carries one; null otherwise. */
  sessionId: string | null;
  tokens: Tokens | null;
  /** Tokens by agent id, summed from the usage of each assistant message; null where the stream states none. Absent: null. */
  agentTokens?: Record<string, Tokens> | null;
  costUsd: number | null;
  /** What the harness says it loaded at startup: its plugin directories, skills, agents, rules, hooks and MCP servers. */
  loaded: Loaded;
  error: string | null;
  /**
   * True when the harness itself says the agent asked the user and stopped for the answer, which an adapter reads from
   * its own stream. Null or absent: it says nothing. Only an adapter with the `askUser` capability sets it; the
   * signals are unconfirmed against a real run until Task 29.
   */
  askedUser?: boolean | null;
  /** True when the harness's own result says it stopped at its turn limit. Such a stop is no error. Absent: false. */
  hitMaxTurns?: boolean;
  /**
   * True when `error` is only that the stream has no ending (no result, `turn_end` or `step_finish` event), which is
   * what a stream cut by a stop or a timeout looks like. Any other error, a harness-reported one included, leaves it
   * false. Absent: false.
   */
  unfinished?: boolean;
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
  /**
   * The text to send: the prompt, or, for an `invoke` turn, the user's syntax from `Harness.userInvocation`; empty for
   * an `event` turn.
   */
  prompt: string;
  /** Which turn this is, for an adapter that needs more than `prompt`. */
  turn: TurnInput;
  /**
   * The previous turn's `Parsed.sessionId`, which the adapter continues by its own means; null for the first turn of
   * the run and for the first turn after a `clear`. Only an adapter with the `multiTurn` capability is given one.
   */
  session: string | null;
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
export interface Harness extends HistoryAdapter {
  id: string;
  /** The name of the executable on PATH. */
  bin: string;
  /** Login files to copy into the throwaway home, relative to the user's home. */
  authFiles: string[];
  /** Variables of the user's environment that carry the harness's login or choose its provider; they reach it by name. */
  authEnv: string[];
  /** What the adapter can observe or do, each proven by a parser test on a stream. A case that needs more is not applicable. */
  capabilities: ReadonlySet<Capability>;
  /**
   * The revision of the command line the adapter builds, from 1. A change to the arguments that can change what a run
   * does, such as a new flag, raises it, so that a stored result made with the earlier command line is not reused. The
   * run key carries it for a revision above 1 only, so the keys of earlier runs stay what they were.
   */
  argvRevision: number;
  /** How far the adapter is proven: a real model ran, a scripted endpoint ran, or neither (see agents/verified). */
  status: "real-model" | "scripted" | "unverified";
  invocation: (input: RunInput) => Invocation;
  /**
   * The text that a user types to invoke a skill: the harness's own syntax, such as `/skill args`. Present exactly for
   * an adapter with the `userInvoke` capability, which declares it only once the syntax is confirmed from the CLI.
   * @param invoke - The skill, and the arguments the user gives it.
   * @returns The prompt to send.
   */
  userInvocation?: (invoke: Invoke) => string;
  /**
   * Whether the adapter reads a cost from the stream. False for a harness whose stream states none: `--max-cost`
   * cannot count its runs, so the command refuses it.
   */
  reportsCost: boolean;
  /**
   * Tells whether the error of a finished run is a rate limit, so that the run may be tried again after a wait
   * (`--retries`). Absent: never. The patterns are not verified against real harnesses.
   */
  isRateLimit?: (error: string) => boolean;
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
   * Counts turns as the stream arrives, so that the runner can stop a run at `maxTurns`. Present exactly for an adapter
   * with the `turnGrouping` capability. A turn is a main-thread assistant turn as that adapter's `turn` numbering has
   * it; a subagent's turns never count. Called once per line of standard output that is a JSON value, in order.
   * @param line - One parsed line of the stream.
   * @param state - Raises `turns` when the line begins a turn that the stream has not shown before.
   */
  countTurns?: (line: unknown, state: TurnState) => void;
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
   * Where each of a subject's rule files goes, for an adapter with the `rules` capability, which declares it only once
   * the mechanism is confirmed from the CLI. A pure function: the loader uses it to refuse a rule that would land on a
   * file of a case's workspace or home.
   * @param files - The rule files and the instruction file.
   * @returns One place for each file, in the same order.
   */
  rulesTargets?: (files: RulesFile[]) => RulesTarget[];
  /**
   * Installs a subject's rule files the way the harness reads them: a native rules directory, an instruction-file
   * import, or both. Present exactly for an adapter with the `rules` capability. Called once per run, before the
   * harness starts; it never overwrites a file.
   * @param files - The rule files and the instruction file, in the run's copy of the subject.
   * @param input - The run's home and workspace.
   * @returns What it installed, as `home/<path>` or `workspace/<path>`, in the order of `files`.
   * @throws {Error} When a place is taken or a file cannot be copied; the run is then invalid.
   */
  installRules?: (
    files: RulesFile[],
    input: Pick<RunInput, "home" | "workspace">,
  ) => string[];
  /**
   * Removes what the options of a subject spec switch off (`hooks=off`, `agents=off`, `agents=except:<glob>`) from an
   * export, which is a copy. Present for an adapter that knows where its harness reads hook configuration and agent
   * definitions from; a spec that asks for such an option is a usage error for a harness without it.
   * @param dir - The export.
   * @param options - The options of the subject spec.
   * @throws {UsageError} When a file that holds hooks or agents cannot be read as it must be.
   */
  strip?: (dir: string, options: SubjectOptions) => void;
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
  return stdout.split("\n").flatMap((line) => {
    const event = jsonLine(line);
    return event === undefined ? [] : [event];
  });
}

/**
 * Reads one line of a stream of one JSON object per line. The runner's turn count reads lines with this too, so that it
 * counts exactly what the parse sees.
 * @param line - One line, without its newline.
 * @returns The object; undefined for a log line, which is anything that does not start with a brace or is not JSON.
 */
export function jsonLine(line: string): unknown {
  if (!line.startsWith("{")) return undefined;
  try {
    return JSON.parse(line);
  } catch {
    // A log line that happens to start with a brace; the stream itself is one object per line.
    return undefined;
  }
}

/**
 * Finds what the main agent last said, for a run that was stopped before its harness wrote a final answer.
 * @param transcript - The run's transcript.
 * @returns The text of the last main-thread assistant text event; empty when there is none.
 */
export const lastAssistantText = (transcript: TranscriptEvent[]): string =>
  transcript
    .filter(
      (event) =>
        event.role === "assistant" &&
        event.type === "text" &&
        event.agent.depth === 0 &&
        event.text,
    )
    .at(-1)?.text ?? "";

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
 * A copy that is already there is kept: a later turn of a run asks the adapter again, and must not undo what the agent
 * changed in the copy.
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
      if (!fs.existsSync(target)) {
        fs.cpSync(source, target, {
          recursive: true,
          dereference: true,
          filter: (file) => !NOT_SKILL_CONTENT.has(path.basename(file)),
        });
      }
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

/**
 * Joins the text of a list of content blocks.
 * @param blocks - Blocks of a message or a tool result; those that are not text, and a value that is no list, add nothing.
 * @returns The text of the `text` blocks, joined without a separator.
 */
export const joinText = (blocks: unknown): string =>
  Array.isArray(blocks)
    ? (blocks as { type?: string; text?: string }[])
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("")
    : "";
