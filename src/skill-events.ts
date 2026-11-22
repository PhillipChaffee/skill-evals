import fs from "node:fs";
import path from "node:path";
import type { ToolCall } from "./harnesses/shared.js";
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
  /** The per-run copy of the subject; null for none. */
  dir: string | null;
  /** Skill name to the directory of the skill in the per-run copy. */
  skillDirs: Record<string, string>;
  /** Skill name to the directory where the adapter placed a copy of it. */
  placed?: Record<string, string> | undefined;
}

/** Where the run's paths start, and how to read a path from a call. */
export interface SkillPaths {
  /** The run's throwaway home, for `~` and `$HOME`. */
  home: string;
  /** The harness's working directory, which a relative path is resolved against. */
  workspace: string;
  /** The adapter's `pathOf`: the file a read-kind call targets. */
  pathOf: (call: ToolCall) => string | null;
}

/** One call of the 0.0.1 rule. */
export interface SkillLoad {
  skill: string;
  index: number;
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);
const READERS = new Set(["cat", "head", "tail", "less", "bat", "nl"]);
const ENV_ASSIGNMENT = /^[A-Za-z_]\w*=/;
const SKILL_FILE = /^skill\.md$/i;
const LEGACY_FILE = /skills[\\/]+([\w-]+)[\\/]+skill\.md/gi;

/**
 * Finds the real path of a path that need not exist: the real path of its nearest existing parent, and the rest.
 * @param target - An absolute path.
 * @returns The path with every link of the existing part followed.
 */
function realish(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    const parent = path.dirname(target);
    return parent === target
      ? target
      : path.join(realish(parent), path.basename(target));
  }
}

/**
 * Tells whether a path is an existing directory, which no read command reads as a file.
 * @param target - A path.
 * @returns True for a directory.
 */
function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
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
 * Expands a leading `~` or `$HOME` of a word of a shell command.
 * @param word - An unquoted word.
 * @param home - The run's home.
 * @returns The word, with the home directory in place of the shorthand.
 */
function withHome(word: string, home: string): string {
  const match = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/.exec(word);
  return match ? home + word.slice(match[0].length) : word;
}

/**
 * Tells which skill a path belongs to.
 * @param target - A path as the call gave it.
 * @param where - The run's directories and the skill roots.
 * @param where.workspace - What a relative path is resolved against.
 * @param where.roots - The directories of the subject's skills.
 * @returns The skill, and the path of the file relative to its directory; null when the path is in none of them.
 */
function locate(
  target: string,
  where: { workspace: string; roots: Root[] },
): { skill: string; relative: string } | null {
  const real = realish(path.resolve(where.workspace, target));
  if (isDirectory(real)) return null;
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
 * @returns The commands of the script when the command is a shell given a `-c` script (which may nest), else the
 *   command itself.
 */
function unwrap(words: string[]): string[][] {
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
  return shellWords(script).flatMap(unwrap);
}

/**
 * Names the skill that a shell command reads, if its command is a read command.
 * @param words - One command of a shell call, as `shellWords` gives it.
 * @returns The words after the command's name, or none when the command is not a reader.
 */
function readerArguments(words: string[]): string[] {
  const start = words.findIndex((word) => !ENV_ASSIGNMENT.test(word));
  const name = path.basename(words[start] ?? "");
  const rest = words.slice(start + 1);
  if (READERS.has(name)) return rest;
  return name === "sed" && /^-n/.test(rest[0] ?? "") ? rest : [];
}

/**
 * Finds the skill files a call reads.
 * @param call - One tool call.
 * @param paths - How to read the call, and where its paths start.
 * @param roots - The directories of the subject's skills.
 * @returns The skill and relative path for each distinct file the call reads. A read-kind call reads the file `pathOf`
 *   gives; a shell-kind call reads the files its read commands name. Nothing else reads a file.
 */
function readsOf(
  call: ToolCall,
  paths: SkillPaths,
  roots: Root[],
): { skill: string; relative: string }[] {
  const where = { workspace: paths.workspace, roots };
  let targets: string[] = [];
  if (call.kind === "read") {
    targets = [paths.pathOf(call) ?? ""].filter(Boolean);
  } else if (call.kind === "shell") {
    const { command } = Object(call.input) as Record<string, unknown>;
    targets =
      typeof command === "string"
        ? shellWords(command).flatMap(unwrap).flatMap(readerArguments)
        : [];
  }
  const found = targets
    .map((target) => locate(withHome(target, paths.home), where))
    .filter((one) => one !== null);
  return found.filter(
    (one, at) =>
      found.findIndex(
        (other) => other.skill === one.skill && other.relative === one.relative,
      ) === at,
  );
}

/**
 * Reads the skill a call of the skill tool names.
 * @param input - The call's input.
 * @returns The name with any `plugin:` prefix dropped; undefined when the input names none.
 */
function namedSkill(input: unknown): string | undefined {
  // Object() turns an input that is no object into one with none of the three keys.
  const given = Object(input) as Record<string, unknown>;
  const named = [given["skill"], given["name"], given["id"]].find(
    (value) => typeof value === "string",
  );
  return named?.slice(named.lastIndexOf(":") + 1);
}

/**
 * Finds every call that gave the agent a skill, or a file of one.
 * @param calls - Every tool call of a run.
 * @param subject - What the run loaded.
 * @param paths - The run's directories, and the adapter's way to read a path from a call.
 * @returns The events in the order of the calls. A skill-kind call that names a skill is a `skill_tool` load, resolved
 *   when the skill is the subject's. A read-kind call, or a shell call whose command reads (`cat`, `head`, `tail`,
 *   `less`, `bat`, `nl`, `sed -n`), of a file that really lies in a skill directory of the subject is a `file_read` or
 *   `shell_read` event: a `load` for the skill's `SKILL.md`, a `file_read` for any other file. A search, a listing, a
 *   `grep`, and a path in the workspace are none.
 */
export function skillEvents(
  calls: ToolCall[],
  subject: SkillSubject,
  paths: SkillPaths,
): SkillEvent[] {
  const roots = rootsOf(subject);
  const own = new Set(roots.map(({ skill }) => skill));
  return calls.flatMap((call, position): SkillEvent[] => {
    const index = call.index ?? position;
    if (call.kind === "skill") {
      const skill = namedSkill(call.input);
      return skill
        ? [
            {
              skill,
              via: "skill_tool",
              index,
              resolved: own.has(skill),
              type: "load",
            },
          ]
        : [];
    }
    const via = call.kind === "read" ? "file_read" : "shell_read";
    return readsOf(call, paths, roots).map(({ skill, relative }) =>
      SKILL_FILE.test(relative)
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
  return toolCalls.flatMap(({ kind, input, index: own }, position) => {
    const index = own ?? position;
    const names: string[] = [];
    const named = kind === "skill" ? namedSkill(input) : undefined;
    if (named) names.push(named);
    for (const match of JSON.stringify(input ?? null).matchAll(LEGACY_FILE)) {
      names.push(String(match[1]));
    }
    return names.map((skill) => ({ skill, index }));
  });
}
