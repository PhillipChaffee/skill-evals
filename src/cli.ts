import fs from "node:fs";
import type { ParseArgsOptionDescriptor } from "node:util";
import { parseArgs } from "node:util";
import { HARNESSES, findBin } from "./harnesses/index.js";
import { check } from "./probe.js";
import type { Project } from "./project.js";
import { findProject, withConfig } from "./project.js";
import { renderCoverage } from "./report/markdown.js";
import { coverageOf, loadSelection, selectionOf, splitList } from "./select.js";
import { UsageError, requireSupportedPlatform } from "./scope.js";
import { EXIT } from "./exit-codes.js";
import { failed } from "./fatal.js";
import type { Flag, FlagSpec } from "./flags.js";
import { FLAGS } from "./flags.js";
import type { CommandDoc, Options } from "./usage.js";
import { commandUsage, commandsTaking, usageText } from "./usage.js";
import { calibrate } from "./commands/calibrate.js";
import { plan } from "./commands/plan.js";
import { suite } from "./commands/suite.js";
import { validate } from "./commands/validate.js";

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
  "jobs",
  "retries",
  "max-cost",
  "max-duration",
  "model",
  "min-score",
  "max-invalid",
  "report",
  "judge-harness",
  "judge-model",
  "judge-api",
  "judge-url",
  "decision-model",
  "decision-url",
  "decision-timeout",
  "lenient",
  "isolated",
  "out",
  "resume",
  "dry-run",
];

// The flags that only a comparison of two subjects uses.
const COMPARE_FLAGS: Flag[] = ["min-delta", "noise", "seed"];

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
      suite({ ...options, subjects: [a, b ?? project.root] }, project),
    flags: ["a", "b", ...SUITE_FLAGS, ...COMPARE_FLAGS],
  },
  score: {
    description: "Run every case against one subject and print its scores.",
    handler: ({ subject, ...options }, project) =>
      suite({ ...options, subjects: [subject ?? project.root] }, project),
    flags: ["subject", ...SUITE_FLAGS],
  },
  calibrate: {
    description:
      'Run the subject against itself, five reps by default, and write noise.json beside results.json: how much each case score, check and the suite score move when nothing changed. run --noise reads it, so that a difference inside that spread reads "within noise".',
    handler: calibrate,
    flags: [
      "subject",
      "seed",
      ...SUITE_FLAGS.filter((flag) => !["min-score", "dry-run"].includes(flag)),
    ],
  },
  plan: {
    description:
      "Print what run or score would make: the matrix of harnesses, cases, subjects and reps, the number of runs, and the cases that are not applicable. With --resume or --out naming an earlier command's directory, also an estimate of cost and duration. It starts no harness and writes nothing.",
    handler: plan,
    flags: [
      "a",
      "b",
      "subject",
      ...SUITE_FLAGS.filter((flag) => flag !== "dry-run"),
      ...COMPARE_FLAGS,
    ],
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
  if (spec.read === undefined) return given;
  const number = spec.read(given);
  if (Number.isNaN(number)) {
    throw new UsageError(`--${flag} is not a decimal number: "${given}"`);
  }
  return number;
}

/**
 * Runs `parseArgs` over the flags of a command.
 * @param name - The command's name, for the message.
 * @param command - The command, which names the flags it takes.
 * @param args - The command line after the command's name.
 * @returns The values `parseArgs` read.
 * @throws {TypeError} With a code that starts with `ERR_PARSE_ARGS`, for a flag the command does not take. When
 *   another command takes the flag, the message says which.
 */
function parsed(name: string, command: Command, args: string[]) {
  try {
    return parseArgs({
      args,
      options: Object.fromEntries(
        command.flags.map((flag) => {
          const spec: FlagSpec = FLAGS[flag];
          if (spec.kind === "switch") return [flag, { type: "boolean" }];
          return [flag, { type: "string", multiple: spec.kind === "list" }];
        }),
      ) as Record<string, ParseArgsOptionDescriptor>,
    }) as { values: Record<string, string | boolean | (string | boolean)[]> };
  } catch (error) {
    const flag = /Unknown option '--([^']+)'/.exec(String(error))?.[1];
    if (flag === undefined || !Object.hasOwn(FLAGS, flag)) throw error;
    const takers = commandsTaking(COMMANDS, flag as Flag).join(", ");
    throw new UsageError(
      `Unknown option '--${flag}' for ${name}: ${name} does not take it; it applies to ${takers}`,
    );
  }
}

/**
 * Reads the flags of a command.
 * @param name - The command's name.
 * @param command - The command, which names the flags it takes.
 * @param args - The command line after the command's name.
 * @returns The options that are set, each under the name the code uses for it.
 * @throws {TypeError} With a code that starts with `ERR_PARSE_ARGS`, for a flag the command does not take.
 */
function readOptions(name: string, command: Command, args: string[]): Options {
  const { values } = parsed(name, command, args);
  return Object.fromEntries(
    Object.entries(values).map(([flag, given]) => {
      const spec: FlagSpec = FLAGS[flag as Flag];
      return [spec.as ?? flag, readFlag(flag, spec, given)];
    }),
  );
}

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
    return EXIT.usage;
  }
  console.log(commandUsage(name, COMMANDS));
  return 0;
}

/**
 * Runs one command line.
 * @param argv - The command and its flags, without the node and script paths.
 * @returns The exit code, from `EXIT`: 0, 1 for a pass bar not reached, 2 with one line on standard error for a wrong
 *   command line, case file, config file, or platform, 3 for invalid runs above `--max-invalid` or a subject that changed,
 *   4 when `--max-cost` or `--max-duration` stopped the command, or 5 for an internal failure, with its stack trace on
 *   standard error. `--help` and `help` print to standard output and give 0; `--help` wins over every other flag. It never
 *   calls process.exit; a signal does, with 130, after the results are written.
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
    const options = readOptions(name ?? "", command, args);
    return await command.handler(options, findProject(process.cwd()));
  } catch (error) {
    return failed(error);
  }
}
