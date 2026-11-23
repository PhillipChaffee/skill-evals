import type { Capability } from "../capabilities.js";
import type { HistoryAdapter } from "../history-types.js";
import type { McpRegistration, McpServerEntry } from "../mcp/types.js";
import type { Stripped, SubjectOptions } from "../subject-options.js";
import type { Loaded } from "./loaded.js";
import type { RulesFile, RulesTarget } from "./rules.js";
import type { Invoke, TurnState } from "./turn-input.js";
import type {
  Invocation,
  LoadedSubject,
  Parsed,
  RunInput,
  ToolCall,
} from "./shared.js";

/** The adapter of one coding-agent CLI. */
export interface Harness extends HistoryAdapter {
  id: string;
  /** The name of the executable on PATH. */
  bin: string;
  /** Login files to copy into the throwaway home, relative to the user's home. */
  authFiles: string[];
  /**
   * What the harness keeps of its own on the operator's machine, which a run must never change; the
   * `no_writes_outside_workspace` check hashes it before and after. Absent: the adapter names none. Name what a person
   * edits to change the harness's behaviour, not what the harness writes as it works: a live session writes the latter
   * every turn.
   * @param env - The operator's environment, for a variable that moves the harness's directory.
   * @returns The paths, each relative to the home or absolute. For a JSON file, `json` lists the key paths to hash, with `*`
   *   for any one key (`projects.*.mcpServers`), because the rest of the file changes while a session runs.
   */
  canaries?: (env: NodeJS.ProcessEnv) => { path: string; json?: string[] }[];
  /** Variables of the user's environment that carry the harness's login or choose its provider; they reach it by name. */
  authEnv: string[];
  /** Variables that no process of the harness gets, whatever the config's `env` says, because they change where it looks. */
  scrubEnv?: string[];
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
   * True when `invocation` starts the harness with no tools at all when it is given `noTools`, which the judge session
   * asks for, since the judge reads text that the agent wrote. Absent: the harness has no such switch, and a judge on it
   * keeps its tools; the command warns.
   */
  noTools?: boolean;
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
   * Reads what a question-kind call asks, from its input, for an adapter with a question tool. Absent: the question is
   * the whole input as JSON.
   * @returns The question text; null for an input that the adapter cannot read.
   */
  questionText?: (input: unknown) => string | null;
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
  /**
   * Tells the harness about the mock MCP servers of a case, for an adapter with the `mcp` capability, which declares it
   * only once the registration mechanism is confirmed from the CLI. Called once per run, before the harness starts. It
   * writes what the harness reads into `dir`, and `invocation` then adds the flag that names it when it is given
   * `mcpDir`.
   * @param servers - The servers, each with the command that starts it and the environment only that server gets.
   * @param input - The run's mock directory, which is outside the workspace and the home, and the run's home and workspace.
   * @throws {Error} When the config cannot be written; the run is then invalid.
   */
  registerMcp?: (servers: McpServerEntry[], input: McpRegistration) => void;
  /**
   * Where the calls to a run's mock MCP servers are seen, for an adapter with the `mcp` capability. `stream` (the
   * default): the stream shows them, so the mock log is only a cross-check and a run whose log and stream disagree is
   * invalid. `log`: the stream cannot show them, so the runner merges the mock log into the transcript.
   */
  mcpCalls?: "stream" | "log";
  /**
   * The harness's own name of an MCP tool, which a call that only the mock log shows gets as its `native` name, as the
   * stream would have named it. Absent: such a call has no native name.
   */
  mcpToolName?: (server: string, tool: string) => string;
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
   * @returns The names of the agents and skills it removed, which a run checks the harness did not load anyway.
   * @throws {UsageError} When a file that holds hooks or agents cannot be read as it must be.
   */
  strip?: (dir: string, options: SubjectOptions) => Stripped;
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
