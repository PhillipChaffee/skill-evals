import type { EvaluateOptions } from "./evaluate.js";
import type { ProbeOptions } from "./probe.js";
import { CONFIG_FILE, CONFIG_KEYS } from "./project.js";

/** Every option a command line can set, under the name the code uses for it. */
export type Options = Omit<
  EvaluateOptions,
  "cwd" | "subjects" | "onRun" | "onWarning"
> &
  ProbeOptions & {
    a?: string;
    b?: string;
    targets?: boolean;
    dryRun?: boolean;
  };

/** One flag: how its text becomes an option, and what the help text and the docs say about it. */
export interface FlagSpec {
  /** The option the flag sets; its own name when absent. */
  as?: keyof Options;
  /** Converts the text; it stays text when absent. */
  read?: (text: string) => number;
  /**
   * How the flag takes its value. "text" (the default) takes one value, "list" may be given again and holds every
   * value, split at commas, and "switch" takes no value and sets its option to true.
   */
  kind?: "text" | "list" | "switch";
  /** What stands for the value after the flag, as in `--reps <n>`. Empty for a switch. */
  value: string;
  /** What the flag sets, in one sentence. */
  description: string;
  /** What applies when the flag is absent. */
  default: string;
  /** The default in a command where it differs, by the command's name. */
  defaultIn?: Record<string, string>;
}

const PROJECT = "the project, uncommitted changes included";

export const FLAGS = {
  a: { value: "subject", description: "The baseline.", default: "main" },
  b: { value: "subject", description: "The change.", default: PROJECT },
  subject: {
    value: "subject",
    description:
      "The subject to score, to probe, or to check the skill names of.",
    default: PROJECT,
  },
  harness: {
    value: "ids|all",
    description: "Comma-separated harness ids.",
    default: "the first installed one",
    defaultIn: { check: "all" },
  },
  case: {
    as: "caseGlob",
    kind: "list",
    value: "globs",
    description:
      "Which case ids to run. A glob: * stays within one directory, ** crosses directories, ? is one character, {a,b} is either. Repeat the flag or separate globs with commas.",
    default: "every case",
  },
  "not-case": {
    as: "notCase",
    kind: "list",
    value: "globs",
    description: "Case ids to leave out, as globs like those of --case.",
    default: "none",
  },
  tag: {
    kind: "list",
    value: "tags",
    description:
      "Run the cases that have any of these tags. Repeat the flag or separate tags with commas.",
    default: "no tag filter",
  },
  "tag-all": {
    as: "tagAll",
    kind: "list",
    value: "tags",
    description: "Run the cases that have all of these tags.",
    default: "no tag filter",
  },
  "not-tag": {
    as: "notTag",
    kind: "list",
    value: "tags",
    description: "Leave out the cases that have any of these tags.",
    default: "none",
  },
  heldout: {
    kind: "switch",
    value: "",
    description:
      "Also run the held-out variants, the ones a case marks with heldout: true. Without it they are left out.",
    default: "off",
  },
  targets: {
    kind: "switch",
    value: "",
    description:
      "Print the coverage table: for each target skill, how many selected cases name it.",
    default: "off",
  },
  cases: {
    value: "dir",
    description: "The directory that holds the cases.",
    default: "evals/cases in the project",
  },
  reps: {
    read: Number,
    value: "n",
    description: "Runs for each subject and case.",
    default: "3",
  },
  jobs: {
    read: Number,
    value: "n",
    description:
      "How many runs may be in flight at once. A positive integer. Each run has its own home, workspace and copy of the subject. results.json lists the records in plan order whatever order the runs end in; results.jsonl and the progress lines follow the order they end in.",
    default: "1",
  },
  model: {
    value: "id",
    description: "Passed to the harness unchanged.",
    default: "the harness's own default",
  },
  "min-score": {
    as: "minScore",
    read: Number,
    value: "0..1",
    description:
      "The lowest suite score that passes. The command exits 1 when the suite score of the subject (B for run) is lower.",
    default: "no bar",
  },
  "judge-harness": {
    as: "judgeHarness",
    value: "id",
    description: "The harness that scores judged checks.",
    default: "the harness under test",
  },
  "judge-model": {
    as: "judgeModel",
    value: "id",
    description: "The model that scores judged checks.",
    default: "the value of --model",
  },
  "judge-api": {
    as: "judgeApi",
    value: "kind",
    description:
      "Ask the judge model over this API and start no harness process for it. Only anthropic. --judge-harness is then ignored.",
    default: "a harness session",
  },
  "judge-url": {
    as: "judgeUrl",
    value: "url",
    description: "The base URL of the judge API.",
    default: "the provider's own",
  },
  "decision-model": {
    as: "decisionModel",
    value: "id",
    description: "The decision model that scores decision checks.",
    default: "none",
  },
  "decision-url": {
    as: "decisionUrl",
    value: "url",
    description: "The base URL of the decision model's API.",
    default: "the provider's own",
  },
  "decision-timeout": {
    as: "decisionTimeout",
    read: Number,
    value: "seconds",
    description:
      "How long one request to the decision model may take. A positive integer.",
    default: "60",
  },
  lenient: {
    kind: "switch",
    value: "",
    description:
      "Drop a key that a case file does not take, and warn, instead of failing. Keys that start with x- are always kept.",
    default: "off: an unknown key is an error",
  },
  isolated: {
    kind: "switch",
    value: "",
    description:
      "Start the harness with nothing loaded but the subject, and mark a run invalid when the harness reports anything else as loaded. Only harnesses that declare the isolated capability take it.",
    default: "off: the harness loads what its settings say",
  },
  out: {
    as: "outDir",
    value: "dir",
    description:
      "Where results go. A fresh run starts an empty results.jsonl there.",
    default: "a new temp directory",
  },
  resume: {
    value: "dir",
    description:
      "Continue the earlier command whose output directory this is. It implies --out and must name the same directory as --out when both are given. A run whose key matches a valid record in results.jsonl is not repeated; every other run is made and added. It also turns the judge cache on.",
    default: "none: a fresh run",
  },
  "dry-run": {
    as: "dryRun",
    kind: "switch",
    value: "",
    description:
      "Print what the command would run, as plan does, and exit 0. It starts no harness and writes nothing.",
    default: "off",
  },
} satisfies Record<string, FlagSpec>;
/** The name of a flag, without its dashes. */
export type Flag = keyof typeof FLAGS;

/** What the help text and the docs say about a command. */
export interface CommandDoc {
  /** What the command does, in one sentence. */
  description: string;
  /** The flags it takes. */
  flags: Flag[];
}

/**
 * Writes a flag the way a user types it.
 * @param flag - The flag's name.
 * @returns The flag with its dashes and the placeholder of its value, as in `--reps <n>`; a flag with no value is just
 *   its name.
 */
export function flagSyntax(flag: Flag): string {
  const spec: FlagSpec = FLAGS[flag];
  return spec.kind === "switch" ? `--${flag}` : `--${flag} <${spec.value}>`;
}

/**
 * Finds the commands that take a flag.
 * @param commands - Every command.
 * @param flag - The flag's name.
 * @returns The names of the commands, in the order of the command table.
 */
export const commandsTaking = (
  commands: Record<string, CommandDoc>,
  flag: Flag,
): string[] =>
  Object.keys(commands).filter((name) => commands[name]?.flags.includes(flag));

/**
 * Says what applies when a flag is absent.
 * @param commands - Every command.
 * @param flag - The flag's name.
 * @returns The default, and the default of each command where it differs.
 */
export function defaultText(
  commands: Record<string, CommandDoc>,
  flag: Flag,
): string {
  const spec: FlagSpec = FLAGS[flag];
  const others = Object.entries(spec.defaultIn ?? {})
    .filter(([name]) => Object.hasOwn(commands, name))
    .map(([name, value]) => `; ${value} for ${name}`);
  return `${spec.default}${others.join("")}`;
}

const pad = (texts: string[]): string[] => {
  const width = Math.max(...texts.map((text) => text.length));
  return texts.map((text) => text.padEnd(width));
};

const footer =
  (): string => `A subject is what a run loads: a directory, a git ref of the project, or "none" for no skills at all.
A directory or ref with a plugin manifest is loaded as a plugin. Any other is a folder of skills.
The project is the git repository that holds the working directory, or the working directory itself.
${CONFIG_FILE} in the project can set a default for these keys:
${Object.keys(CONFIG_KEYS).join(", ")}.`;

/**
 * Writes the help text from the command and flag tables.
 * @param commands - Every command.
 * @returns What a wrong command line prints: each command, each flag with its default and the commands that take
 *   it, and what a subject and the config file are.
 */
export function usageText(commands: Record<string, CommandDoc>): string {
  const names = pad(Object.keys(commands));
  const flags = Object.keys(FLAGS) as Flag[];
  const syntax = pad(flags.map(flagSyntax));
  return `Usage: skill-evals <command> [options]

Commands:
${Object.values(commands)
  .map((command, index) => `  ${String(names[index])}  ${command.description}`)
  .join("\n")}

Options, each with its default and the commands that take it:
${flags
  .map(
    (flag, index) =>
      `  ${String(syntax[index])}  ${FLAGS[flag].description}\n      default: ${defaultText(commands, flag)} (${commandsTaking(commands, flag).join(", ")})`,
  )
  .join("\n")}

skill-evals help <command> or skill-evals <command> --help shows one command. --help takes no value and wins over every other flag.

${footer()}`;
}

/**
 * Writes the help text of one command.
 * @param name - The command's name, which must be a key of `commands`.
 * @param commands - Every command.
 * @returns What the command does, only the flags it takes, each with its default, and what a subject and the config
 *   file are.
 */
export function commandUsage(
  name: string,
  commands: Record<string, CommandDoc>,
): string {
  const command = commands[name];
  const flags = command?.flags ?? [];
  const syntax = pad(flags.map(flagSyntax));
  const defaultOf = (flag: Flag): string => {
    const spec: FlagSpec = FLAGS[flag];
    return spec.defaultIn?.[name] ?? spec.default;
  };
  return `Usage: skill-evals ${name} [options]

${command?.description ?? ""}

Options, each with its default:
${flags
  .map(
    (flag, index) =>
      `  ${String(syntax[index])}  ${FLAGS[flag].description}\n      default: ${defaultOf(flag)}`,
  )
  .join("\n")}

${footer()}`;
}
