import fs from "node:fs";
import path from "node:path";
import type { ToolCall } from "./harnesses/shared.js";
import { skillNameArg } from "./harnesses/shared.js";
import { shellWords } from "./shell-words.js";

/** How the agent got at a skill's text. `injected` is reserved for a harness that puts a skill into the context itself. */
export type SkillVia = "skill_tool" | "file_read" | "shell_read" | "injected";

/** Every `via`, in the order the docs list them. */
export const SKILL_VIAS: readonly SkillVia[] = [
  "skill_tool",
  "file_read",
  "shell_read",
  "injected",
];
/** The mechanisms that a check without `via` accepts: the ones an agent really uses. */
export const REAL_VIAS: readonly SkillVia[] = [
  "skill_tool",
  "file_read",
  "shell_read",
];

/** One call that gave the agent a skill, or a file of one. */
export interface SkillEvent {
  /** The skill's name, without any plugin prefix. */
  skill: string;
  via: SkillVia;
  /** The call's position in the run's list. */
  index: number;
  /** True when the skill is a skill of the loaded subject. */
  resolved: boolean;
  /** `load` is the skill itself; `file_read` is another file under its directory, named by `file`. */
  type: "load" | "file_read";
  /** For `file_read`: the file's path relative to the skill's directory, with `/`. */
  file?: string;
}

/** What the run loaded, as the rule needs it. */
export interface SkillSubject {
  /** Skill name to the directory of the skill in the per-run copy. */
  skillDirs: Record<string, string>;
  /** Skill name to the directory where the adapter placed a copy of it. */
  placed?: Record<string, string> | undefined;
  /** A plugin's own name: the only prefix under which the skill tool names the subject's skills. Absent: none. */
  pluginName?: string | null | undefined;
}

/** Where the run's paths start, and how to read a call. */
export interface SkillPaths {
  /** The run's throwaway home, for `~` and `$HOME`. */
  home: string;
  /** The harness's working directory, which a relative path is resolved against. */
  workspace: string;
  /** The adapter's `pathOf`: the file a read-kind call targets. */
  pathOf: (call: ToolCall) => string | null;
  /** The adapter's `skillOf`: the skill a skill-kind call names, prefix included. Absent: `skillNameArg`. */
  skillOf?: ((call: ToolCall) => string | null) | undefined;
  /** The positions of the calls whose tool result was an error, from the transcript. A skill-tool call among them is not resolved. Absent: none failed. */
  failed?: ReadonlySet<number> | undefined;
}

/** One call of the 0.0.1 rule. */
export interface SkillLoad {
  skill: string;
  index: number;
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);
const READERS = new Set(["cat", "head", "tail", "less", "bat", "nl"]);
const ENV_ASSIGNMENT = /^[A-Za-z_]\w*=/;
const SKILL_FILE = "SKILL.md";
const LEGACY_FILE = /skills[\\/]+([\w-]+)[\\/]+skill\.md/gi;
// `>`, `>>`, `2>`, `&>` and the like, with the target attached or not.
const OUTPUT_REDIRECT = /^(?:\d*|&)>>?(.*)$/;
const HEREDOC_WORD = /^<<-?(.*)$/;

/**
 * Finds the real path of a path that need not exist: the real path of its nearest existing parent, and the rest.
 * @param target - An absolute path.
 * @returns The path with every link of the existing part followed, and the case of its names as the disk has them.
 */
function realish(target: string): string {
  try {
    return fs.realpathSync.native(target);
  } catch {
    const parent = path.dirname(target);
    return parent === target
      ? target
      : path.join(realish(parent), path.basename(target));
  }
}

/**
 * Tells whether a path is an existing regular file, which is all a read command reads.
 * @param target - A path.
 * @returns True for a file.
 */
function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/** A directory that holds one skill, with the skill's name. */
interface Root {
  skill: string;
  real: string;
}

/**
 * Lists the directories that hold the subject's skills: its per-run copy and the copies the adapter placed.
 * @param subject - What the run loaded.
 * @returns One root for each directory, with its real path.
 */
function rootsOf(subject: SkillSubject): Root[] {
  return [
    ...Object.entries(subject.skillDirs),
    ...Object.entries(subject.placed ?? {}),
  ].map(([skill, dir]) => ({ skill, real: realish(path.resolve(dir)) }));
}

/**
 * Tells which skill a file belongs to.
 * @param target - A path as the call gave it.
 * @param where - The directory a relative path starts from, and the skill roots.
 * @param where.base - What a relative path is resolved against.
 * @param where.roots - The directories of the subject's skills.
 * @returns The skill, and the path of the file relative to its directory; null when the path is no existing file in
 *   one of them.
 */
function locate(
  target: string,
  where: { base: string; roots: Root[] },
): { skill: string; relative: string } | null {
  const real = realish(path.resolve(where.base, target));
  if (!isFile(real)) return null;
  for (const { skill, real: root } of where.roots) {
    const relative = path.relative(root, real);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      return { skill, relative: relative.split(path.sep).join("/") };
    }
  }
  return null;
}

/**
 * Looks inside a command that runs a shell on a script, such as Codex's `/bin/bash -lc 'cat file'`.
 * @param words - One command of a shell call, as `shellWords` gives it.
 * @param home - The run's home, for the script's own `~` and `$HOME`.
 * @returns The commands of the script when the command is a shell given a `-c` script (which may nest), else the
 *   command itself.
 */
function unwrap(words: string[], home: string): string[][] {
  const start = words.findIndex((word) => !ENV_ASSIGNMENT.test(word));
  const flag = words.findIndex(
    (word, at) => at > start && /^-[a-z]*c[a-z]*$/.test(word),
  );
  const script = words[flag + 1];
  if (
    !SHELLS.has(path.basename(words[start] ?? "")) ||
    flag < 0 ||
    script === undefined
  ) {
    return [words];
  }
  return shellWords(script, home).flatMap((inner) => unwrap(inner, home));
}

/**
 * Drops the redirections of a command's words, which name files it writes or feeds, not files it reads.
 * @param words - The words after a command's name.
 * @returns The operands: the words of `>`, `>>`, `2>`, `&>` and `<<` redirections are gone with their targets, and
 *   the file of a `<` is an operand.
 */
function operands(words: string[]): string[] {
  const kept: string[] = [];
  for (let at = 0; at < words.length; at++) {
    const word = words[at] ?? "";
    const output = OUTPUT_REDIRECT.exec(word);
    const heredoc = HEREDOC_WORD.exec(word);
    if (output ?? heredoc) {
      at += (output?.[1] ?? heredoc?.[1]) === "" ? 1 : 0;
    } else if (word.startsWith("<") && word.length > 1) {
      kept.push(word.slice(1));
    } else if (word !== "<") {
      kept.push(word);
    }
  }
  return kept;
}

/**
 * Tells whether a `sed` command only prints, which is how it reads a file.
 * @param options - The words of the command that start with a dash.
 * @returns True with `-n` (alone or in a cluster such as `-ne`) and without `-i` or `--in-place`.
 */
function printsOnly(options: string[]): boolean {
  const short = (word: string, flag: string): boolean =>
    !word.startsWith("--") && new RegExp(`^-[A-Za-z]*${flag}`).test(word);
  const quiet = options.some(
    (word) => short(word, "n") || word === "--quiet" || word === "--silent",
  );
  const inPlace = options.some(
    (word) => short(word, "i") || word.startsWith("--in-place"),
  );
  return quiet && !inPlace;
}

/**
 * Names the operands that a command reads, if it is a read command.
 * @param words - One command of a shell call, as `shellWords` gives it.
 * @returns The operands of `cat`, `head`, `tail`, `less`, `bat`, `nl` and of `sed` that prints; none for any other
 *   command, or for a `sed` that edits in place.
 */
function readerArguments(words: string[]): string[] {
  const start = words.findIndex((word) => !ENV_ASSIGNMENT.test(word));
  const name = path.basename(words[start] ?? "");
  const rest = words.slice(start + 1);
  if (READERS.has(name)) return operands(rest);
  const prints =
    name === "sed" && printsOnly(rest.filter((word) => word.startsWith("-")));
  return prints ? operands(rest) : [];
}

/** A file of a skill that a call reads. */
interface Read {
  skill: string;
  relative: string;
}

/**
 * Finds the targets of the commands of a shell call, following `cd` from one command to the next of the same string.
 * @param command - The text of a shell call.
 * @param paths - The run's home and workspace.
 * @returns The files its read commands name, each with the directory that its relative paths start from.
 */
function shellTargets(
  command: string,
  paths: SkillPaths,
): { target: string; base: string }[] {
  let base = paths.workspace;
  const found: { target: string; base: string }[] = [];
  const commands = shellWords(command, paths.home).flatMap((words) =>
    unwrap(words, paths.home),
  );
  for (const words of commands) {
    const start = words.findIndex((word) => !ENV_ASSIGNMENT.test(word));
    const [directory] = operands(words.slice(start + 1));
    if (path.basename(words[start] ?? "") === "cd" && directory !== undefined) {
      base = path.resolve(base, directory);
    }
    found.push(...readerArguments(words).map((target) => ({ target, base })));
  }
  return found;
}

/**
 * Finds the skill files a call reads.
 * @param call - One tool call.
 * @param paths - How to read the call, and where its paths start.
 * @param roots - The directories of the subject's skills.
 * @returns The skill and relative path for each distinct file the call reads. A read-kind call reads the file `pathOf`
 *   gives; a shell-kind call reads the files its read commands name. Nothing else reads a file.
 */
function readsOf(call: ToolCall, paths: SkillPaths, roots: Root[]): Read[] {
  let targets: { target: string; base: string }[] = [];
  if (call.kind === "read") {
    const target = paths.pathOf(call);
    targets = target ? [{ target, base: paths.workspace }] : [];
  } else if (call.kind === "shell") {
    const { command } = Object(call.input) as Record<string, unknown>;
    targets = typeof command === "string" ? shellTargets(command, paths) : [];
  }
  const found = targets
    .map(({ target, base }) => locate(target, { base, roots }))
    .filter((one) => one !== null);
  return found.filter(
    (one, at) =>
      found.findIndex(
        (other) => other.skill === one.skill && other.relative === one.relative,
      ) === at,
  );
}

/**
 * Finds every call that gave the agent a skill, or a file of one.
 * @param calls - Every tool call of a run.
 * @param subject - What the run loaded.
 * @param paths - The run's directories, and the adapter's way to read a path and a skill name from a call.
 * @returns The events in the order of the calls. A skill-kind call that names a skill is a `skill_tool` load, with
 *   any `plugin:` prefix dropped from `skill`; it is resolved when the skill is the subject's, the name has no
 *   prefix or the subject's own plugin name as the prefix, and its tool result was not an error. A read-kind call, or a shell call whose command reads
 *   (`cat`, `head`, `tail`, `less`, `bat`, `nl`, `sed -n`), of an existing file in a skill directory of the subject
 *   is a `file_read` or `shell_read` event: a `load` for the skill's `SKILL.md`, a `file_read` for any other file. A
 *   search, a listing, a `grep`, a redirection target, and a path in the workspace are none.
 */
export function skillEvents(
  calls: ToolCall[],
  subject: SkillSubject,
  paths: SkillPaths,
): SkillEvent[] {
  const roots = rootsOf(subject);
  const own = new Set(roots.map(({ skill }) => skill));
  const skillOf = paths.skillOf ?? skillNameArg;
  return calls.flatMap((call, position): SkillEvent[] => {
    const index = call.index ?? position;
    if (call.kind === "skill") {
      const named = skillOf(call);
      if (!named) return [];
      const colon = named.lastIndexOf(":");
      const prefix = colon < 0 ? null : named.slice(0, colon);
      const skill = named.slice(colon + 1);
      const resolved =
        !paths.failed?.has(index) &&
        own.has(skill) &&
        (prefix === null || prefix === (subject.pluginName ?? undefined));
      return [{ skill, via: "skill_tool", index, resolved, type: "load" }];
    }
    const via = call.kind === "read" ? "file_read" : "shell_read";
    return readsOf(call, paths, roots).map(({ skill, relative }) =>
      relative === SKILL_FILE
        ? { skill, via, index, resolved: true, type: "load" }
        : {
            skill,
            via,
            index,
            resolved: true,
            type: "file_read",
            file: relative,
          },
    );
  });
}

/**
 * Lists the skills the agent loaded.
 * @param events - The run's skill events.
 * @returns The sorted, distinct names of the skills of the `load` events.
 */
export const skillsLoaded = (events: SkillEvent[]): string[] =>
  [
    ...new Set(
      events.filter(({ type }) => type === "load").map(({ skill }) => skill),
    ),
  ].sort();

/**
 * Applies the 0.0.1 rule for "the agent loaded a skill", which `--lenient` keeps for one release.
 * @param toolCalls - Every tool call of a run.
 * @returns One load for each skill a call names: a call of the harness's skill tool that names it (any `plugin:` prefix
 *   dropped), and a call of any tool whose input mentions `skills/<name>/SKILL.md`, in any case. Its `index` is the
 *   call's own `index`, or its position when the call has none.
 */
export function legacySkillLoads(toolCalls: ToolCall[]): SkillLoad[] {
  return toolCalls.flatMap((call, position) => {
    const index = call.index ?? position;
    const names: string[] = [];
    const named = call.kind === "skill" ? skillNameArg(call) : null;
    if (named) names.push(named.slice(named.lastIndexOf(":") + 1));
    for (const match of JSON.stringify(call.input ?? null).matchAll(
      LEGACY_FILE,
    )) {
      names.push(String(match[1]));
    }
    return names.map((skill) => ({ skill, index }));
  });
}
