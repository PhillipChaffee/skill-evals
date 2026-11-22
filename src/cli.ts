import type { ParseArgsOptionDescriptor } from "node:util";
import { parseArgs } from "node:util";
import { check } from "./probe.js";
import type { Project } from "./project.js";
import { findProject } from "./project.js";
import { splitList } from "./select.js";
import { UsageError, requireSupportedPlatform } from "./scope.js";
import { EXIT } from "./exit-codes.js";
import { failed } from "./fatal.js";
import type { Flag, FlagSpec } from "./flags.js";
import { FLAGS } from "./flags.js";
import { COMPARE_FLAGS, SUITE_FLAGS } from "./command-flags.js";
import type { CommandDoc, Options } from "./usage.js";
import { commandUsage, commandsTaking, usageText } from "./usage.js";
import { calibrate } from "./commands/calibrate.js";
import { diff } from "./commands/diff.js";
import { explain } from "./commands/explain.js";
import { init } from "./commands/init.js";
import { list } from "./commands/list.js";
import { rejudge } from "./commands/rejudge.js";
import { show } from "./commands/show.js";
import { plan } from "./commands/plan.js";
import { subjectsOf } from "./commands/subjects.js";
import { suite } from "./commands/suite.js";
import { validate } from "./commands/validate.js";

/** A command: what it does with its options, the flags it takes, and what the help text says about it. */
interface Command extends CommandDoc {
  handler: (
    options: Options,
    project: Project,
    args: string[],
  ) => number | Promise<number>;
}

// Every command. The help text and the docs are written from this table and from FLAGS.
export const COMMANDS: Record<string, Command> = {
  run: {
    description:
      "Run every case against subject A and subject B, score both, and print a comparison.",
    handler: ({ a, b, subjects, ...options }, project) =>
      suite(
        { ...options, ...subjectsOf({ a, b, subjects }, project) },
        project,
      ),
    flags: [
      "a",
      "b",
      "subjects",
      "bar-subject",
      ...SUITE_FLAGS,
      ...COMPARE_FLAGS,
    ],
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
      "subjects",
      "bar-subject",
      ...SUITE_FLAGS.filter((flag) => !["dry-run", "yes"].includes(flag)),
      ...COMPARE_FLAGS,
    ],
  },
  check: {
    description:
      "Run one small prompt in each installed harness and show what its adapter reports.",
    handler: check,
    flags: ["subject", "harness", "model", "out", "json"],
  },
  validate: {
    description:
      "Check a suite without running it: report every case that does not load, every skill name the subject lacks, and every word in what the agent reads that hints at a test (a warning; see blindingWords). It never runs a setup step: --deep runs them in a throwaway directory and also looks at the paths they make. Spends nothing.",
    handler: validate,
    flags: [
      "subject",
      "cases",
      "lenient",
      "deep",
      "case",
      "not-case",
      "tag",
      "tag-all",
      "not-tag",
      "heldout",
    ],
  },
  rejudge: {
    description:
      "Score the runs of an earlier command again, against the cases as they are now, without starting the agent. It reads the directory under its lock and never changes its results.json or results.jsonl: it writes results.rejudged.json beside them and prints the report, or the full set of files into --out. Judge answers come from the judge cache of the directory. A run whose prompt, files or setup changed is not re-scored; a run without a workspace archive (--keep-workspaces) keeps the old score of each check that needs files.",
    handler: rejudge,
    positionals: ["out dir"],
    flags: [
      "cases",
      "case",
      "judge-model",
      "judge-api",
      "judge-harness",
      "lenient",
      "out",
    ],
  },
  diff: {
    description:
      "Compare two sets of results, each an output directory or a results.json: the score change of each case with its run counts, the checks that started or stopped failing, and the change in cost and duration. A warning block comes first when the models, harnesses, tool version or any case differ. It informs and exits 0; --strict turns a warning into exit 2.",
    handler: diff,
    positionals: ["a", "b"],
    flags: ["strict"],
  },
  init: {
    description:
      "Write prompt.md and case.json for a new case from a template of the given kind, under the cases directory. The id may be a path, such as routing/commit-guard. It refuses an id that no case could have and a directory that exists. Every template loads and passes validate; replace its placeholders before the first run.",
    handler: init,
    positionals: ["id"],
    flags: ["kind", "cases"],
  },
  explain: {
    description:
      "Print one case as a run reads it, as JSON in Markdown: the prompt, the layers of files in order, the setup steps, every check with its defaults written out, the capabilities it needs, and whether each installed harness can run it. A case with variants lists them. It starts no harness: what is installed comes from a lookup on PATH.",
    handler: explain,
    positionals: ["id"],
    flags: ["cases", "lenient"],
  },
  show: {
    description:
      "Print what one run did: one line for each transcript event, with its agent, kind, name and input or output cut at 200 characters, and then each check with its score and reason. A tool call is numbered as the checks number it (`call #0`), so a reason that quotes a call can be found. It reads the output directory of an earlier command, takes no lock, and changes nothing.",
    handler: show,
    positionals: ["out dir", "case"],
    flags: ["subject", "rep"],
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
      "show-prompts",
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
      allowPositionals: true,
      options: Object.fromEntries(
        command.flags.map((flag) => {
          const spec: FlagSpec = FLAGS[flag];
          if (spec.kind === "switch") return [flag, { type: "boolean" }];
          return [flag, { type: "string", multiple: spec.kind === "list" }];
        }),
      ) as Record<string, ParseArgsOptionDescriptor>,
    }) as {
      values: Record<string, string | boolean | (string | boolean)[]>;
      positionals: string[];
    };
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
 * Reads the flags and the arguments of a command.
 * @param name - The command's name.
 * @param command - The command, which names the flags and the arguments it takes.
 * @param args - The command line after the command's name.
 * @returns The options that are set, each under the name the code uses for it, and the arguments.
 * @throws {TypeError} With a code that starts with `ERR_PARSE_ARGS`, for a flag the command does not take.
 * @throws {UsageError} When the number of arguments is not the number the command takes.
 */
function readOptions(
  name: string,
  command: Command,
  args: string[],
): { options: Options; positionals: string[] } {
  const { values, positionals } = parsed(name, command, args);
  const takes = command.positionals ?? [];
  if (positionals.length !== takes.length) {
    const wanted =
      takes.length === 0
        ? "no arguments"
        : `exactly ${takes.map((one) => `<${one}>`).join(" ")}`;
    throw new UsageError(
      `${name} takes ${wanted}, not ${String(positionals.length)} ${positionals.length === 1 ? "argument" : "arguments"}`,
    );
  }
  return {
    positionals,
    options: Object.fromEntries(
      Object.entries(values).map(([flag, given]) => {
        const spec: FlagSpec = FLAGS[flag as Flag];
        return [spec.as ?? flag, readFlag(flag, spec, given)];
      }),
    ),
  };
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
    const { options, positionals } = readOptions(name ?? "", command, args);
    return await command.handler(
      options,
      findProject(process.cwd()),
      positionals,
    );
  } catch (error) {
    return failed(error);
  }
}
