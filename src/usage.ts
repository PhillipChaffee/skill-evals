import type { EvaluateOptions } from "./evaluate.js";
import type { ProbeOptions } from "./probe.js";
import { CONFIG_FILE, CONFIG_KEYS } from "./project.js";

/** Every option a command line can set, under the name the code uses for it. */
export type Options = Omit<
  EvaluateOptions,
  "cwd" | "subjects" | "onRun" | "onWarning"
> &
  ProbeOptions & { a?: string; b?: string };

/** One flag: how its text becomes an option, and what the help text and the docs say about it. */
export interface FlagSpec {
  /** The option the flag sets; its own name when absent. */
  as?: keyof Options;
  /** Converts the text; it stays text when absent. */
  read?: (text: string) => number;
  /** True for a flag that takes no value: it sets its option to true. */
  boolean?: true;
  /** What stands for the value after the flag, as in `--reps <n>`. Empty for a boolean flag. */
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
    description: "The subject to score or to probe.",
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
    value: "glob",
    description: "Which case ids to run. Only * is special.",
    default: "*",
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
    boolean: true,
    value: "",
    description:
      "Drop a key that a case file does not take, and warn, instead of failing. Keys that start with x- are always kept.",
    default: "off: an unknown key is an error",
  },
  isolated: {
    boolean: true,
    value: "",
    description:
      "Start the harness with nothing loaded but the subject, and mark a run invalid when the harness reports anything else as loaded. Only harnesses that declare the isolated capability take it.",
    default: "off: the harness loads what its settings say",
  },
  out: {
    as: "outDir",
    value: "dir",
    description: "Where results go.",
    default: "a new temp directory",
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
  return spec.boolean ? `--${flag}` : `--${flag} <${spec.value}>`;
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

A subject is what a run loads: a directory, a git ref of the project, or "none" for no skills at all.
A directory or ref with a plugin manifest is loaded as a plugin. Any other is a folder of skills.
The project is the git repository that holds the working directory, or the working directory itself.
${CONFIG_FILE} in the project can set a default for these keys:
${Object.keys(CONFIG_KEYS).join(", ")}.`;
}
