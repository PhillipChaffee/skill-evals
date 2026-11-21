import fs from "node:fs";
import type { ParseArgsOptionDescriptor } from "node:util";
import { parseArgs } from "node:util";
import type { EvaluateOptions } from "./evaluate.js";
import { evaluate } from "./evaluate.js";
import { HARNESSES, findBin } from "./harnesses/index.js";
import { check } from "./probe.js";
import type { Project } from "./project.js";
import { findProject, withConfig } from "./project.js";
import { renderCoverage, renderReport } from "./report.js";
import type { RunRecord } from "./run.js";
import { invalidReason } from "./run.js";
import { formatScore } from "./score.js";
import { coverageOf, loadSelection, selectionOf, splitList } from "./select.js";
import { UsageError, requireSupportedPlatform } from "./scope.js";
import { SUBJECT_CHANGED_EXIT_CODE, sourceChangedMessage } from "./subject.js";
import type { CommandDoc, Flag, FlagSpec, Options } from "./usage.js";
import { FLAGS, commandUsage, usageText } from "./usage.js";
import { validate } from "./commands/validate.js";

const USAGE_EXIT_CODE = 2;

/**
 * Runs the suite, prints its report to standard output, and prints one line for each finished run to standard error.
 * @param options - What to evaluate.
 * @returns The exit code: 1 when any run is invalid, a pass bar is not reached, or the subject directory changed
 *   during the command, else 0.
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
  if (evaluation.sourceChanged.length > 0) {
    console.error(
      `skill-evals: ${sourceChangedMessage(evaluation.sourceChanged)}`,
    );
    return SUBJECT_CHANGED_EXIT_CODE;
  }
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
  const chosen = fs.existsSync(options.cases)
    ? loadSelection(options.cases, selectionOf(options), {
        lenient: options.lenient ?? false,
      })
    : null;
  const cases = chosen
    ? [
        ...chosen.map(
          (caseDef) =>
            `- ${caseDef.id}: ${String(caseDef.checks.length)} checks`,
        ),
        "",
        `${String(chosen.length)} cases selected`,
        ...(options.targets ? ["", ...renderCoverage(coverageOf(chosen))] : []),
      ]
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

const SUITE_FLAGS: Flag[] = [
  "harness",
  "case",
  "not-case",
  "tag",
  "tag-all",
  "not-tag",
  "heldout",
  "cases",
  "reps",
  "model",
  "min-score",
  "judge-harness",
  "judge-model",
  "decision-model",
  "decision-url",
  "decision-timeout",
  "lenient",
  "isolated",
  "out",
];

/** A command: what it does with its options, the flags it takes, and what the help text says about it. */
interface Command extends CommandDoc {
  handler: (options: Options, project: Project) => number | Promise<number>;
}

// Every command. The help text and the docs are written from this table and from FLAGS.
export const COMMANDS: Record<string, Command> = {
  run: {
    description:
      "Run every case against subject A and subject B, score both, and print a comparison.",
    handler: ({ a = "main", b, ...options }, project) =>
      suite({ ...options, subjects: [a, b ?? project.root] }),
    flags: ["a", "b", ...SUITE_FLAGS],
  },
  score: {
    description: "Run every case against one subject and print its scores.",
    handler: ({ subject, ...options }, project) =>
      suite({ ...options, subjects: [subject ?? project.root] }),
    flags: ["subject", ...SUITE_FLAGS],
  },
  check: {
    description:
      "Run one small prompt in each installed harness and show what its adapter reports.",
    handler: check,
    flags: ["subject", "harness", "model", "out"],
  },
  validate: {
    description:
      "Check a suite without running it: report every case that does not load and every skill name the subject lacks. Spends nothing.",
    handler: validate,
    flags: [
      "subject",
      "cases",
      "lenient",
      "case",
      "not-case",
      "tag",
      "tag-all",
      "not-tag",
      "heldout",
    ],
  },
  list: {
    description:
      "Show the harnesses in default-preference order, and the cases.",
    handler: list,
    flags: [
      "cases",
      "lenient",
      "case",
      "not-case",
      "tag",
      "tag-all",
      "not-tag",
      "heldout",
      "targets",
    ],
  },
};

const USAGE = usageText(COMMANDS);

/**
 * Converts what `parseArgs` gave for one flag.
 * @param flag - The flag's name, for the message.
 * @param spec - The flag's entry in `FLAGS`.
 * @param given - A switch's boolean, a list flag's texts, or a text.
 * @returns The option's value: a boolean, the items of a list, or the text as the flag reads it.
 * @throws {UsageError} When a list flag holds no item, as in `--case ""`.
 */
function readFlag(
  flag: string,
  spec: FlagSpec,
  given: string | boolean | (string | boolean)[],
) {
  if (Array.isArray(given)) {
    const items = splitList(given.map(String));
    if (items.length === 0) {
      throw new UsageError(`--${flag} needs at least one value`);
    }
    return items;
  }
  if (typeof given === "boolean") return given;
  return (spec.read ?? String)(given);
}

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
      command.flags.map((flag) => {
        const spec: FlagSpec = FLAGS[flag];
        if (spec.kind === "switch") return [flag, { type: "boolean" }];
        return [flag, { type: "string", multiple: spec.kind === "list" }];
      }),
    ) as Record<string, ParseArgsOptionDescriptor>,
  }) as { values: Record<string, string | boolean | (string | boolean)[]> };
  return Object.fromEntries(
    Object.entries(values).map(([flag, given]) => {
      const spec: FlagSpec = FLAGS[flag as Flag];
      return [spec.as ?? flag, readFlag(flag, spec, given)];
    }),
  );
}

const isParseArgsError = (error: unknown): error is Error =>
  error instanceof Error &&
  "code" in error &&
  String(error.code).startsWith("ERR_PARSE_ARGS");

/**
 * Prints the help text for `--help`, `help`, and `help <command>`.
 * @param name - The command to describe; absent for the whole tool.
 * @returns The exit code: 0, or 2 with a line on standard error when the command is unknown.
 */
function help(name: string | undefined): number {
  if (name === undefined) {
    console.log(USAGE);
    return 0;
  }
  if (!Object.hasOwn(COMMANDS, name)) {
    console.error(`skill-evals: unknown command "${name}"\n\n${USAGE}`);
    return USAGE_EXIT_CODE;
  }
  console.log(commandUsage(name, COMMANDS));
  return 0;
}

/**
 * Runs one command line.
 * @param argv - The command and its flags, without the node and script paths.
 * @returns The exit code: 0, 1 when a run is invalid or a pass bar is not reached, or 2 with one line on standard
 *   error for a wrong command line, case file, config file, or platform. `--help` and `help` print to standard output
 *   and give 0; `--help` wins over every other flag. It never calls process.exit.
 */
export async function main(argv: string[]): Promise<number> {
  const [name, ...args] = argv;
  if (name === "--help") return help(undefined);
  if (name === "help")
    return help(args.includes("--help") ? undefined : args[0]);
  if (
    name !== undefined &&
    Object.hasOwn(COMMANDS, name) &&
    args.includes("--help")
  ) {
    return help(name);
  }
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
