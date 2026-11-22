import path from "node:path";
import { childEnv } from "./env.js";
import type { ExecResult } from "./exec.js";
import { exec } from "./exec.js";
import type {
  Harness,
  Invocation,
  Parsed,
  RunInput,
} from "./harnesses/shared.js";
import { NOT_REPORTED, withIndexes } from "./harnesses/shared.js";
import type { RulesFile } from "./harnesses/rules.js";
import type { Seeded } from "./history-plant.js";
import { withPreamble } from "./history.js";
import type { History, HistoryMode } from "./history-types.js";
import { watchDirs } from "./isolate.js";
import { messageOf } from "./scope.js";
import type { ChangedFiles, Snapshot } from "./snapshot.js";
import { mergeChanges, snapshot } from "./snapshot.js";
import type { Ending } from "./retry.js";
import type { OnTimeout, StoppedBy } from "./session-end.js";
import type { TurnRecord } from "./turn-outcome.js";
import type { Turn } from "./turn-spec.js";
import type { McpSource } from "./mcp/types.js";
import type { Layers } from "./workspace.js";
import { turnWatch } from "./turn-watch.js";
import { copyHome } from "./workspace.js";

/** The two directories of a run. */
export interface Dirs {
  /** The throwaway home. */
  home: string;
  /** The workspace the agent works in. */
  workspace: string;
  /** The run's mock MCP directory, outside both of the above; absent for a case with no `mcp/`. */
  mcp?: string | undefined;
}

/** One prompt for one harness. */
export interface SessionInput {
  harness: Harness;
  /** The harness's executable. */
  bin: string;
  /** What the harness loads; null loads nothing. */
  subject: RunInput["subject"];
  prompt: string;
  /**
   * The turns of a case with `turns`: each is run by its own harness process, in the same workspace and home, and
   * `prompt` is then not sent. Absent or null: `prompt` is the one turn.
   */
  turns?: Turn[] | null | undefined;
  model?: string | undefined;
  maxTurns?: number | undefined;
  /** What a run that hits `timeoutSeconds` is: "invalid" (the default), or "score" to score what it left. */
  onTimeout?: OnTimeout | undefined;
  /** Start the harness with nothing loaded but the subject. */
  isolated?: boolean | undefined;
  /** The seconds each process may take; with `turns`, each turn's. */
  timeoutSeconds: number;
  /** The seconds all turns together may take. Absent: `timeoutSeconds` times the number of turns. */
  totalTimeoutSeconds?: number | undefined;
  /** `--history-mode`: how the case's history reaches the agent. Absent: the harness's own mode. */
  historyMode?: HistoryMode | undefined;
  /** What the case puts in the workspace and the home, and the steps that set it up; absent for an empty workspace. */
  layers?: Layers | undefined;
  /** Environment variables the harness must not get, such as the key of the model that scores its answer. */
  withhold?: string[] | undefined;
  /** Names of this process's variables the project's config passes to the harness. */
  pass?: string[] | undefined;
  /** Variables a case sets for the agent, with their values. They reach the agent's process only. */
  env?: Record<string, string> | undefined;
  /** The subject's rule files and instruction file in the run's copy; null or absent when the subject names none. */
  rules?: RulesFile[] | null | undefined;
  /** The case's mock MCP servers; absent for a case with no `mcp/`. */
  mcp?: McpSource | undefined;
  /** Take the seed copy of the workspace even when the case has no `command` check, so that the run can be archived. */
  keepSeed?: boolean | undefined;
}

/** What a session produced, seen while its workspace still exists. */
export interface SessionResult {
  /** The case's history, which the run writes to its history file; null for a run with no history. */
  seeded: History | null;
  stdout: string;
  parsed: Parsed;
  /** The harness's own message when it produced a stream, else why the process failed. For turns, the first failure, with its turn. */
  error: string | null;
  durationMs: number;
  /** Who ended the run: "agent" unless the runner stopped the process at the turn limit or the time limit. */
  stoppedBy: StoppedBy;
  /** The main-thread turns begun, counted from the stream; null for a harness that cannot count turns. */
  turns: number | null;
  /** Milliseconds from the start of the prompt to the first byte of output; null when none came. */
  firstOutputMs: number | null;
  /** What decides whether a failed run may be tried again; `retryKind` reads it with the record. */
  ending: Ending;
  workspace: string;
  /**
   * What the run changed in the copies of the skills that the adapter placed in the home, as paths inside the
   * subject; null when the adapter placed none.
   */
  placedChanges: ChangedFiles | null;
  /** Each turn of a case with `turns`, in order; null for a single prompt. */
  userTurns: TurnRecord[] | null;
  /** What each turn changed in the workspace, from a hash taken after it; null for a single prompt. */
  turnChanges: ChangedFiles[] | null;
  /** The workspace as the agent starts from it: the copies and the setup steps done. */
  seed: Snapshot;
  /** The run's throwaway home, which exists until the callback returns. */
  home: string;
  /** The home just before the harness's prompt ran: the auth files, the placed skills, and what setup wrote. */
  homeSeed: Snapshot;
  /** Where the adapter placed each skill: skill name to directory; absent when it placed none. */
  placed: Record<string, string> | undefined;
  /** The workspace as the copy left it, kept as a directory; null unless the case has a command check or the run is kept. */
  seedDir: string | null;
  /** The run's directory for bare remotes and linked worktrees, which exists until the callback returns; null without a case. */
  remoteDir: string | null;
  /** The held-out directory, copied after the agent exited; null when the case has none or has no command check. */
  graderDir: string | null;
  /** Where the adapter put the subject's rules; null when the subject names none, empty when the harness installs none. */
  rulesInstalled: string[] | null;
  /** The names of the mock MCP servers the run registered; empty for a case with none. */
  mcpServers: string[];
  /** What the mock servers logged, as the log file holds it (one JSON object per line); null for a case with no `mcp/`. */
  mcpLog: string | null;
}

const SHOWN_SETUP_WORDS = 2;

/** What the first turn of a run set up, and the later turns of the same run reuse. */
export interface Prior {
  /** Lists what the run changed in the skill copies placed in the home, since they were placed. */
  changes: () => ChangedFiles | null;
  /** Where the adapter and its setup placed each skill. */
  placed: Record<string, string>;
  /** The home just before the harness's first prompt. */
  homeSeed: Snapshot;
}

/** What running the prompt left, before the stream is read. */
export interface Attempt {
  stdout: string;
  failure: string | null;
  durationMs: number;
  /** How the process ended: its failure kind, and whether the runner stopped it. */
  exec: Pick<ExecResult, "kind" | "stopped" | "exit" | "signal">;
  turns: number | null;
  /** Why the turn counter threw, or null. */
  fault: string | null;
  firstOutputMs: number | null;
  placedChanges: ChangedFiles | null;
  placed?: Record<string, string> | undefined;
  homeSeed: Snapshot;
  /** What a later turn reuses; null when the harness never started. */
  prior: Prior | null;
}

/**
 * Starts watching the copies of skills that an adapter placed in the home.
 * @param subject - What the run loads.
 * @param placed - Skill name to the directory of its copy, as the adapter reported it.
 * @returns A function that lists what changed in them since now, or null when the adapter placed none.
 */
function watchPlaced(
  subject: RunInput["subject"],
  placed: Record<string, string> | undefined,
): () => ChangedFiles | null {
  const dirs = Object.entries(placed ?? {}).map(([name, dir]) => ({
    dir,
    prefix: path
      .relative(subject?.dir ?? "", subject?.skillDirs[name] ?? "")
      .split(path.sep)
      .join("/"),
  }));
  return dirs.length === 0 ? () => null : watchDirs(dirs);
}

/**
 * Makes the function that builds the harness's environment.
 * @param session - Which harness, and what it may and may not get.
 * @param home - The throwaway home.
 * @param harnessEnv - What the adapter's invocation sets.
 * @returns A function from the case's own variables to the whole environment.
 */
const environmentOf =
  (session: SessionInput, home: string, harnessEnv: Record<string, string>) =>
  (caseEnv: Record<string, string>) =>
    childEnv({
      home,
      base: process.env,
      harnessEnv,
      authEnv: session.harness.authEnv,
      pass: session.pass ?? [],
      withhold: session.withhold ?? [],
      caseEnv,
    });

/**
 * Runs the harness's setup steps, in order, until one fails.
 * @param bin - The harness's executable.
 * @param steps - The argument lists of the steps.
 * @param options - Where and how to run them.
 * @param options.cwd - The workspace.
 * @param options.env - The environment of the harness.
 * @param options.timeoutSeconds - How long each step may take.
 * @returns Why the first failing step failed, naming its first words; null when every step worked.
 */
async function setupFailure(
  bin: string,
  steps: string[][],
  options: { cwd: string; env: Record<string, string>; timeoutSeconds: number },
): Promise<string | null> {
  for (const step of steps) {
    const { failure } = await exec(bin, step, options);
    if (failure) {
      const command = step.slice(0, SHOWN_SETUP_WORDS).join(" ");
      return `setup "${command}": ${failure}`;
    }
  }
  return null;
}

/**
 * Finds the skill copies that the harness made itself during setup, and starts watching them.
 * @param harness - The adapter, which may know where its setup put them.
 * @param input - What the adapter builds the command line from.
 * @returns The copies, and a function that lists what changed in them since now.
 */
function afterSetup(
  harness: Harness,
  input: RunInput,
): { placed: Record<string, string>; changes: () => ChangedFiles | null } {
  const placed = harness.placedAfterSetup?.(input) ?? {};
  return { placed, changes: watchPlaced(input.subject, placed) };
}

/**
 * Joins two lists of changes, either of which may be absent.
 * @param first - The changes of the copies the adapter placed.
 * @param second - The changes of the copies the harness made in setup.
 * @returns Both merged; whichever exists when only one does; null when neither does.
 */
const joined = (
  first: ChangedFiles | null,
  second: ChangedFiles | null,
): ChangedFiles | null =>
  first && second ? mergeChanges(first, second) : (first ?? second);

/**
 * Makes the result of a run whose harness never started.
 * @param failure - Why: the setup step that failed.
 * @param home - The run's throwaway home.
 * @returns What `attempt` returns, with no output and no time.
 */
export const notStarted = (failure: string, home: string): Attempt => ({
  stdout: "",
  failure,
  durationMs: 0,
  exec: { kind: null, stopped: false, exit: null, signal: null },
  turns: null,
  fault: null,
  firstOutputMs: null,
  placedChanges: null,
  placed: undefined,
  homeSeed: snapshot(home),
  prior: null,
});

/**
 * Prepares the harness for a run's first prompt: places what the adapter placed, runs its setup steps, and puts the
 * case's home files in.
 * @param session - Which harness, and how long it may take.
 * @param run - What the adapter built for this turn, and the environment it asks for.
 * @param run.input - What the adapter builds the command line from.
 * @param run.invocation - What the adapter built.
 * @returns What later turns reuse; or the result of a run that cannot start.
 */
async function prepare(
  session: SessionInput,
  run: { input: RunInput; invocation: Invocation },
): Promise<Prior | Attempt> {
  const { input, invocation } = run;
  const placedChanges = watchPlaced(input.subject, invocation.placed);
  const environment = environmentOf(session, input.home, invocation.env);
  const options = {
    cwd: input.workspace,
    env: environment({}),
    timeoutSeconds: session.timeoutSeconds,
  };
  const failure = await setupFailure(
    session.bin,
    invocation.setup ?? [],
    options,
  );
  if (failure) {
    return {
      ...notStarted(failure, input.home),
      placedChanges: placedChanges(),
      placed: invocation.placed,
    };
  }
  const late = afterSetup(session.harness, input);
  const clash = copyHome(session.layers?.homeDir ?? null, input.home);
  if (clash) return notStarted(clash, input.home);
  return {
    changes: () => joined(placedChanges(), late.changes()),
    placed: { ...invocation.placed, ...late.placed },
    homeSeed: snapshot(input.home),
  };
}

/**
 * Tells a prepared run from one that could not start.
 * @param ready - What `prepare` returned.
 * @returns True for the result of a run that could not start.
 */
const failed = (ready: Prior | Attempt): ready is Attempt => "failure" in ready;

/**
 * Prepares the harness and runs the prompt. For a later turn of a run, `prior` is what the first turn set up, and
 * nothing is set up again.
 * @param session - Which harness, and how long it may take.
 * @param input - What the adapter builds the command line from.
 * @param prior - What an earlier turn of this run set up; null for the first turn.
 * @returns The harness's output, why it failed if it did, and how long the prompt itself took; setup is not timed.
 */
export async function attempt(
  session: SessionInput,
  input: RunInput,
  prior: Prior | null = null,
): Promise<Attempt> {
  let invocation;
  try {
    invocation = session.harness.invocation(input);
  } catch (error) {
    return notStarted(
      `could not prepare the run: ${messageOf(error)}`,
      input.home,
    );
  }
  const ready = prior ?? (await prepare(session, { input, invocation }));
  if (failed(ready)) return ready;
  const environment = environmentOf(session, input.home, invocation.env);
  const started = Date.now();
  const watch = turnWatch(session.harness, session.maxTurns);
  const result = await exec(session.bin, invocation.args, {
    cwd: input.workspace,
    env: environment(session.env ?? {}),
    timeoutSeconds: session.timeoutSeconds,
    stdin: invocation.stdin,
    // Whatever the agent left running goes with it, so a background process cannot hold the run until its time limit.
    reapOnExit: true,
    onStdout: watch?.onStdout,
  });
  return {
    ...result,
    exec: result,
    turns: watch?.turns() ?? null,
    fault: watch?.fault() ?? null,
    durationMs: Date.now() - started,
    placedChanges: ready.changes(),
    placed: ready.placed,
    homeSeed: ready.homeSeed,
    prior: ready,
  };
}

/**
 * Normalizes a harness's output.
 * @param harness - The adapter that reads the stream.
 * @param stdout - What the harness wrote.
 * @returns What the adapter read, with an error in place of an exception for a stream the adapter cannot read.
 */
export function parseStream(harness: Harness, stdout: string): Parsed {
  try {
    const parsed = harness.parse(stdout);
    return { ...parsed, toolCalls: withIndexes(parsed.toolCalls) };
  } catch (error) {
    return {
      finalText: "",
      toolCalls: [],
      transcript: [],
      sessionId: null,
      tokens: null,
      costUsd: null,
      loaded: NOT_REPORTED,
      error: `the ${harness.id} adapter could not read the stream: ${messageOf(error)}`,
    };
  }
}

/**
 * Gathers what the adapter builds the command line from, for a run with one prompt.
 * @param run - The harness, the prompt, and what to load.
 * @param where - The run's directories, and what was planted in them.
 * @param where.dirs - The run's throwaway home and workspace.
 * @param where.seeded - What planting the case's history left: the block in front of the prompt, or the session to resume.
 * @returns The input of `invocation`.
 */
export const inputOf = (
  run: SessionInput,
  where: { dirs: Dirs; seeded: Seeded },
): RunInput => {
  const message = withPreamble(where.seeded.preamble, run.prompt);
  return {
    subject: run.subject,
    home: where.dirs.home,
    workspace: where.dirs.workspace,
    prompt: message,
    turn: { index: 0, message, invoke: null, event: null },
    session: where.seeded.session,
    model: run.model,
    maxTurns: run.maxTurns,
    isolated: run.isolated,
    mcpDir: where.dirs.mcp,
  };
};
