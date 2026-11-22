import fs from "node:fs";
import path from "node:path";
import { UsageError } from "./scope.js";

// Every capability a harness adapter can declare, with what it means. The docs list the capabilities from this table.
export const CAPABILITIES = {
  subagents:
    "The stream shows when the agent starts another agent, as a tool call of the kind `subagent`.",
  multiTurn:
    "The harness takes more than one prompt in one session, so a case can have several turns.",
  userInvoke:
    "A case can invoke a skill the way a user does, with a slash command, and not through the agent's own tool call.",
  toolOutputs:
    "The stream carries what each tool returned, so a check can read a tool's output.",
  assistantText:
    "The stream carries the agent's text between its tool calls, not only its final answer.",
  turnGrouping:
    "The stream says which tool calls belong to one assistant turn, so a check can ask for calls in the same turn.",
  childCalls:
    "The stream attributes each tool call to the agent that made it, so a check can tell a subagent's calls from the parent's.",
  childText:
    "The stream carries the text that a subagent wrote, apart from the parent's.",
  rules:
    "The adapter installs the subject's rules and instruction file (the config's `rules` and `instructionFile`) the way the harness reads them, so a case can plant a rule and see it obeyed.",
  rulesReport:
    "The harness reports the rule and instruction texts it loaded, so a check can show that a rule reached the model.",
  hooks:
    "The stream shows each hook that ran, with its event, exit code and the context it added, so a check can read a hook's result.",
  history:
    "A case can start from a conversation that already happened, written into the first prompt or into the harness's own store.",
  historyNative:
    "A case can start from a conversation written into the harness's own session store and resumed from it.",
  askUser:
    "The stream shows when the agent asks the user a question, so a case can answer it.",
  toolDurations:
    "The stream says how long each tool call took, so a check can bound it.",
  sessionStore:
    "The harness keeps its sessions in files that a run can read after it ends.",
  compact: "A case can compact the conversation between turns.",
  clear: "A case can clear the conversation between turns.",
  resume: "A case can resume an earlier session in a later run.",
  mcp: "The harness starts the MCP servers that a case configures, and the stream shows their tool calls.",
  skillListing:
    "The harness lists the skills it loaded at startup, so a run whose subject is missing from the list is invalid.",
  loadedReport:
    "The harness reports the plugins and skills it loaded at startup, which `--isolated` and the subject-loaded test read.",
  isolated:
    "The harness starts with nothing loaded but what the run gives it and proves that from its report, so `--isolated` can promise it. It needs `loadedReport` too.",
  sandbox:
    "The machine has an OS sandbox backend that `--sandbox` runs the harness in; found once when a command starts.",
} as const satisfies Record<string, string>;

/** The name of something a harness can observe or do. */
export type Capability = keyof typeof CAPABILITIES;

/** What a case or a check can need: a capability of the harness, or `bin:<name>`, an executable on the host's `PATH`. */
export type Need = Capability | `bin:${string}`;

// The shape of a host capability. The name stays out of the shell and out of a path.
const BIN = /^bin:[A-Za-z0-9._+-]+$/;
/** What a need looks like, as a regular expression, for the JSON Schema of the case file. */
export const NEED_PATTERN = `^(${Object.keys(CAPABILITIES).join("|")}|${BIN.source.slice(1, -1)})$`;

/**
 * Tells whether a word is a capability name.
 * @param word - Any string.
 * @returns True for a key of CAPABILITIES; an inherited property name is not one.
 */
const isCapability = (word: string): word is Capability =>
  Object.hasOwn(CAPABILITIES, word);

/**
 * Reads a `requires` list.
 * @param value - The parsed value.
 * @param where - Names the file, the check or the case, and the key in an error message.
 * @returns The needs, in the order written.
 * @throws {UsageError} When the value is not a list of strings, or a string is neither a capability name nor
 *   `bin:<name>`. The message lists the names that are known.
 */
export function readNeeds(value: unknown, where: string): Need[] {
  if (!Array.isArray(value)) {
    throw new UsageError(
      `${where}: "requires" must be a list of capability names`,
    );
  }
  return value.map((word: unknown) => {
    if (typeof word === "string" && (isCapability(word) || BIN.test(word))) {
      return word as Need;
    }
    const known = [...Object.keys(CAPABILITIES), "bin:<name>"].join(", ");
    throw new UsageError(
      `${where}: unknown capability ${JSON.stringify(word)}; known: ${known}`,
    );
  });
}

/**
 * Tells whether a path can be spawned.
 * @param file - A path, which need not exist.
 * @returns True for a regular file that this user may execute.
 */
export function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Looks for an executable on `PATH`.
 * @param name - A file name, with no directory part.
 * @param env - Where `PATH` is read from.
 * @returns The first executable of that name on `PATH`, or null.
 */
export function findOnPath(
  name: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  return (
    (env["PATH"] ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((dir) => path.join(dir, name))
      .find(isExecutable) ?? null
  );
}
