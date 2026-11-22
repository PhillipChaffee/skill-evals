import type { EvaluateOptions } from "./evaluate.js";
import type { ProbeOptions } from "./probe.js";
import type { Flag, FlagSpec } from "./flags.js";
import { FLAGS } from "./flags.js";
import { CONFIG_FILE, CONFIG_KEYS } from "./project.js";

/** Every option a command line can set, under the name the code uses for it. */
export type Options = Omit<
  EvaluateOptions,
  "cwd" | "subjects" | "onRun" | "onFinal" | "onWarning"
> &
  ProbeOptions & {
    a?: string;
    b?: string;
    targets?: boolean;
    dryRun?: boolean;
    strict?: boolean;
  };

/** What the help text and the docs say about a command. */
export interface CommandDoc {
  /** What the command does, in one sentence. */
  description: string;
  /** The flags it takes. */
  flags: Flag[];
  /** What the command takes besides flags, in order, as the usage line writes it: `["a", "b"]` for `<a> <b>`. */
  positionals?: string[];
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
 * Writes a command's name with what it takes.
 * @param name - The word the user types.
 * @param command - The entry of the command table, which lists its arguments.
 * @returns The name and, for each argument it takes, `<argument>`.
 */
export const nameWith = (name: string, command: CommandDoc): string =>
  [name, ...(command.positionals ?? []).map((one) => `<${one}>`)].join(" ");

/**
 * Writes the help text from the command and flag tables.
 * @param commands - Every command.
 * @returns What a wrong command line prints: each command, each flag with its default and the commands that take
 *   it, and what a subject and the config file are.
 */
export function usageText(commands: Record<string, CommandDoc>): string {
  const names = pad(
    Object.entries(commands).map(([name, command]) => nameWith(name, command)),
  );
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
  const taking = (command?.positionals ?? [])
    .map((one) => ` <${one}>`)
    .join("");
  const defaultOf = (flag: Flag): string => {
    const spec: FlagSpec = FLAGS[flag];
    return spec.defaultIn?.[name] ?? spec.default;
  };
  return `Usage: skill-evals ${name}${taking} [options]

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
