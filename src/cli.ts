import fs from "node:fs";
import { parseArgs } from "node:util";
import { loadCases } from "./cases.js";
import type { EvaluateOptions } from "./evaluate.js";
import { evaluate } from "./evaluate.js";
import { HARNESSES, findBin } from "./harnesses/index.js";
import type { ProbeOptions } from "./probe.js";
import { check } from "./probe.js";
import type { Project } from "./project.js";
import { findProject, withConfig } from "./project.js";
import { renderReport } from "./report.js";
import type { RunRecord } from "./run.js";
import { invalidReason } from "./run.js";
import { formatScore } from "./score.js";
import { UsageError, requireSupportedPlatform } from "./scope.js";

const USAGE = `Usage: skill-evals <command> [options]

  run    Run every case against subject A and subject B, score both, and print a comparison.
           --a <subject>          the baseline (default: main)
           --b <subject>          the change (default: the project, uncommitted changes included)
  score  Run every case against one subject and print its scores.
           --subject <subject>    (default: the project, uncommitted changes included)
  run and score also take:
           --harness <ids|all>    comma-separated harness ids (default: the first installed one)
           --case <glob>          case ids to run (default: *)
           --cases <dir>          directory that holds the cases (default: evals/cases in the project)
           --reps <n>             runs for each subject and case (default: 3)
           --model <id>           passed to the harness (default: the harness's own default)
           --min-score <0..1>     exit 1 when the suite score of the subject (B for run) is lower
           --judge-harness <id>   harness that scores judged checks (default: the harness under test)
           --judge-model <id>     model that scores judged checks (default: --model)
           --decision-model <id>  decision model that scores decision checks (no default)
           --decision-url <url>   base URL of the decision model's API (default: the provider's own)
           --out <dir>            where results go (default: a new temp directory)
  check  Run one small prompt in each installed harness and show what its adapter reports.
           --subject <subject>  --harness <ids|all>  (default: all)   --model <id>   --out <dir>
  list   Show harnesses in default-preference order, and the cases.
           --cases <dir>

A subject is what a run loads: a directory, a git ref of the project, or "none" for no skills at all.
A directory or ref with a plugin manifest is loaded as a plugin. Any other is a folder of skills.
The project is the git repository that holds the working directory, or the working directory itself.
skill-evals.config.json in the project can set a default for cases, harness, reps, model, judgeHarness,
judgeModel, decisionModel, decisionUrl, and minScore.`;

const USAGE_EXIT_CODE = 2;

/** Every option a command line can set, under the name the code uses for it. */
type Options = Omit<EvaluateOptions, "cwd" | "subjects" | "onRun"> &
  ProbeOptions & { a?: string; b?: string };

/** How a flag's text becomes an option. */
interface FlagSpec {
  /** The option the flag sets; its own name when absent. */
  as?: keyof Options;
  /** Converts the text; it stays text when absent. */
  read?: (text: string) => number;
}

const FLAGS = {
  a: {},
  b: {},
  subject: {},
  harness: {},
  case: { as: "caseGlob" },
  cases: {},
  reps: { read: Number },
  model: {},
  "min-score": { as: "minScore", read: Number },
  "judge-harness": { as: "judgeHarness" },
  "judge-model": { as: "judgeModel" },
  "decision-model": { as: "decisionModel" },
  "decision-url": { as: "decisionUrl" },
  out: { as: "outDir" },
} satisfies Record<string, FlagSpec>;
type Flag = keyof typeof FLAGS;

const SUITE_FLAGS: Flag[] = [
  "harness",
  "case",
  "cases",
  "reps",
  "model",
  "min-score",
  "judge-harness",
  "judge-model",
  "decision-model",
  "decision-url",
  "out",
];

/**
 * Runs the suite, prints its report to standard output, and prints one line for each finished run to standard error.
 * @param options - What to evaluate.
 * @returns The exit code: 1 when any run is invalid or a pass bar is not reached, else 0.
 */
async function suite(options: EvaluateOptions): Promise<number> {
  const onRun = (record: RunRecord): void => {
    const outcome =
      invalidReason(record) ?? `score ${formatScore(record.score)}`;
    console.error(
      `${record.harness} ${record.caseId} ${record.subject}${String(record.rep)}: ${outcome}`,
    );
  };
  const evaluation = await evaluate({ ...options, onRun });
  console.log(renderReport(evaluation));
  return evaluation.invalid.length || evaluation.belowBar.length ? 1 : 0;
}

/**
 * Prints the harnesses in default-preference order, each with where it is installed, and the cases.
 * @param given - The options of the command line.
 * @param project - Where the config file and the default cases directory are.
 * @returns The exit code, always 0: a missing cases directory is a line of the listing.
 */
function list(given: Options, project: Project): number {
  const options = withConfig(project, given);
  const installed = HARNESSES.map((harness) => ({
    harness,
    bin: findBin(harness),
  }));
  const first = installed.find((entry) => entry.bin);
  const cases = fs.existsSync(options.cases)
    ? loadCases(options.cases).map(
        (caseDef) => `- ${caseDef.id}: ${String(caseDef.checks.length)} checks`,
      )
    : ["- none: the directory does not exist"];
  console.log(
    [
      "Harnesses, in default-preference order:",
      ...installed.map(
        ({ harness, bin }) =>
          `- ${harness.id}: ${bin ? `installed (${bin})` : `not installed ("${harness.bin}" not found)`}`,
      ),
      `Default harness: ${first ? first.harness.id : "none installed"}`,
      "",
      `Cases in ${options.cases}:`,
      ...cases,
    ].join("\n"),
  );
  return 0;
}

/** A command: what it does with its options, and the flags it takes. */
interface Command {
  handler: (options: Options, project: Project) => number | Promise<number>;
  flags: Flag[];
}

const COMMANDS: Record<string, Command> = {
  run: {
    handler: ({ a = "main", b, ...options }, project) =>
      suite({ ...options, subjects: [a, b ?? project.root] }),
    flags: ["a", "b", ...SUITE_FLAGS],
  },
  score: {
    handler: ({ subject, ...options }, project) =>
      suite({ ...options, subjects: [subject ?? project.root] }),
    flags: ["subject", ...SUITE_FLAGS],
  },
  check: { handler: check, flags: ["subject", "harness", "model", "out"] },
  list: { handler: list, flags: ["cases"] },
};

/**
 * Reads the flags of a command.
 * @param command - The command, which names the flags it takes.
 * @param args - The command line after the command's name.
 * @returns The options that are set, each under the name the code uses for it.
 * @throws {TypeError} With a code that starts with `ERR_PARSE_ARGS`, for a flag the command does not take.
 */
function readOptions(command: Command, args: string[]): Options {
  const { values } = parseArgs({
    args,
    options: Object.fromEntries(
      command.flags.map((flag) => [flag, { type: "string" as const }]),
    ),
  });
  return Object.fromEntries(
    Object.entries(values).map(([flag, text]) => {
      const spec: FlagSpec = FLAGS[flag as Flag];
      return [spec.as ?? flag, (spec.read ?? String)(String(text))];
    }),
  );
}

const isParseArgsError = (error: unknown): error is Error =>
  error instanceof Error &&
  "code" in error &&
  String(error.code).startsWith("ERR_PARSE_ARGS");

/**
 * Runs one command line.
 * @param argv - The command and its flags, without the node and script paths.
 * @returns The exit code: 0, 1 when a run is invalid or a pass bar is not reached, or 2 with one line on standard
 *   error for a wrong command line, case file, config file, or platform. It never calls process.exit.
 */
export async function main(argv: string[]): Promise<number> {
  const [name, ...args] = argv;
  try {
    requireSupportedPlatform();
    const command =
      name !== undefined && Object.hasOwn(COMMANDS, name)
        ? COMMANDS[name]
        : undefined;
    if (!command) {
      const problem = name ? `unknown command "${name}"` : "missing command";
      throw new UsageError(`${problem}\n\n${USAGE}`);
    }
    const options = readOptions(command, args);
    return await command.handler(options, findProject(process.cwd()));
  } catch (error) {
    if (!(error instanceof UsageError || isParseArgsError(error))) throw error;
    console.error(`skill-evals: ${error.message}`);
    return USAGE_EXIT_CODE;
  }
}
