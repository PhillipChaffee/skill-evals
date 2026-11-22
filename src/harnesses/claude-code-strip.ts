import fs from "node:fs";
import path from "node:path";
import { UsageError } from "../scope.js";
import { matches } from "../subject-options.js";
import type { Stripped, SubjectOptions } from "../subject-options.js";
import { walkTree } from "../walk.js";

type Json = Record<string, unknown>;

const INDENT = 2;

// The files that can carry a hooks key: the plugin manifest and the project settings of Claude Code.
const MANIFEST = ".claude-plugin/plugin.json";
const SETTINGS = [".claude/settings.json", ".claude/settings.local.json"];
const AGENT_DIRS = ["agents", ".claude/agents"];

/**
 * Reads a JSON object file of the export.
 * @param file - The path of a manifest or settings file, which may not exist.
 * @returns The object; null when the file does not exist.
 * @throws {UsageError} When the file is not a JSON object, which would hide what it configures.
 */
function readObject(file: string): Json | null {
  if (!fs.existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Json;
    }
  } catch {
    // Reported below.
  }
  throw new UsageError(
    `${file} is not a JSON object, so its hooks and agents cannot be removed`,
  );
}

/**
 * Lists the paths that a manifest key names.
 * @param value - A string, a list of strings, or anything else.
 * @returns The strings.
 */
const pathsOf = (value: unknown): string[] =>
  [value].flat().filter((each): each is string => typeof each === "string");

/**
 * Resolves a path that a manifest names to a path inside the export.
 * @param root - The export.
 * @param named - The path as the manifest writes it.
 * @returns The absolute path; null when it leaves the export.
 */
function insideRoot(root: string, named: string): string | null {
  const base = path.resolve(root);
  const file = path.resolve(base, named);
  return file.startsWith(`${base}${path.sep}`) ? file : null;
}

/**
 * Removes a file that a manifest names, when it lies inside the export.
 * @param root - The export.
 * @param named - The path as the manifest writes it.
 */
function removeNamed(root: string, named: string): void {
  const file = insideRoot(root, named);
  if (file !== null) fs.rmSync(file, { force: true });
}

/**
 * Removes the hook configuration: `hooks/hooks.json`, the files that the manifest's `hooks` names, and the `hooks`
 * key of the manifest and of the settings files.
 * @param root - The export.
 */
function removeHooks(root: string): void {
  fs.rmSync(path.join(root, "hooks/hooks.json"), { force: true });
  for (const name of [MANIFEST, ...SETTINGS]) {
    const file = path.join(root, name);
    const object = readObject(file);
    if (object === null || !("hooks" in object)) continue;
    if (name === MANIFEST) {
      for (const named of pathsOf(object["hooks"])) removeNamed(root, named);
    }
    delete object["hooks"];
    fs.writeFileSync(file, `${JSON.stringify(object, null, INDENT)}\n`);
  }
}

/**
 * Tells whether a path that a manifest names is a real directory inside the export. A link is not followed.
 * @param root - The export.
 * @param named - The path as the manifest writes it.
 * @returns True for a directory; false for a file, a link, a missing path, or a path outside the export.
 */
function isDirectory(root: string, named: string): boolean {
  const file = insideRoot(root, named);
  return (
    file !== null && fs.existsSync(file) && fs.lstatSync(file).isDirectory()
  );
}

/**
 * Lists the directories that the manifest names under a key, as paths relative to the export.
 * @param root - The export.
 * @param manifest - The parsed manifest; null for none.
 * @param key - `agents` or `skills`.
 * @returns The named paths that are real directories inside the export; a link is not followed, and a file is no directory.
 */
function namedDirs(root: string, manifest: Json | null, key: string): string[] {
  return pathsOf(manifest?.[key])
    .filter((named) => isDirectory(root, named))
    .map((named) => path.posix.normalize(named.replaceAll("\\", "/")));
}

/**
 * Removes the entries of directories that a filter does not keep. A link is judged by its name and removed as a link,
 * never followed.
 * @param root - The export.
 * @param dirs - The directories to walk, relative to the export; a missing one is skipped.
 * @param rule - Tells whether an entry goes, and names it.
 * @param rule.goes - True for the name of an entry that is removed.
 * @param rule.nameOf - The name of an entry: its file name, without `.md` for an agent.
 * @param rule.only - Which entries are judged: `file` for agents' Markdown files and links, `dir` for skill directories and links.
 * @returns The names that were removed.
 */
function removeEntries(
  root: string,
  dirs: string[],
  rule: {
    goes: (name: string) => boolean;
    nameOf: (file: string) => string;
    only: "file" | "dir";
  },
): string[] {
  const removed: string[] = [];
  for (const dir of dirs) {
    if (!fs.existsSync(path.join(root, dir))) continue;
    walkTree(root, {
      from: dir,
      visit: ({ file, dirent }) => {
        const link = dirent.isSymbolicLink();
        const own =
          rule.only === "dir"
            ? dirent.isDirectory()
            : dirent.isFile() && file.endsWith(".md");
        // A skill's own folders are not skills, so only the top of a skill directory is judged.
        const inside = rule.only === "file" && dirent.isDirectory();
        if (!(link || own)) return inside ? undefined : false;
        const name = rule.nameOf(file);
        if (!rule.goes(name)) return false;
        fs.rmSync(file, { recursive: true, force: true });
        removed.push(name);
        return false;
      },
    });
  }
  return removed;
}

/**
 * Tells whether an agent goes under an `agents` option.
 * @param agents - The `agents` option.
 * @param name - The agent's name, without `.md`.
 * @returns True for every agent under `off`, for one that matches `except`, and for one that does not match `only`.
 */
function agentGoes(
  agents: NonNullable<SubjectOptions["agents"]>,
  name: string,
): boolean {
  if (agents === "off") return true;
  return "except" in agents
    ? matches(agents.except, name)
    : !matches(agents.only, name);
}

/**
 * Removes agent definitions: the Markdown files and links of `agents/`, `.claude/agents/` and every directory that the
 * manifest names, and the manifest's entries for them.
 * @param root - The export.
 * @param agents - The `agents` option.
 * @returns The names of the agents that were removed.
 */
function removeAgents(
  root: string,
  agents: NonNullable<SubjectOptions["agents"]>,
): string[] {
  const manifestFile = path.join(root, MANIFEST);
  const manifest = readObject(manifestFile);
  const goes = (name: string): boolean => agentGoes(agents, name);
  const nameOf = (file: string): string => path.basename(file, ".md");
  const removed = removeEntries(
    root,
    [...AGENT_DIRS, ...namedDirs(root, manifest, "agents")],
    { goes, nameOf, only: "file" },
  );
  if (manifest !== null && "agents" in manifest) {
    const left = pathsOf(manifest["agents"]).filter(
      (named) => isDirectory(root, named) || !goes(nameOf(named)),
    );
    if (left.length === 0) delete manifest["agents"];
    else manifest["agents"] = left;
    fs.writeFileSync(
      manifestFile,
      `${JSON.stringify(manifest, null, INDENT)}\n`,
    );
  }
  return removed;
}

/**
 * Removes the skill directories and links that a `skills` option does not keep from the directories that the manifest
 * names, which the generic skill filter does not look in.
 * @param root - The export.
 * @param skills - The `skills` option.
 * @returns The names of the skills that were removed.
 */
function removeSkillLinks(
  root: string,
  skills: NonNullable<SubjectOptions["skills"]>,
): string[] {
  const manifest = readObject(path.join(root, MANIFEST));
  return removeEntries(
    root,
    ["skills", ...namedDirs(root, manifest, "skills")],
    {
      goes: (name) => matches(skills.glob, name) !== (skills.mode === "only"),
      nameOf: (file) => path.basename(file),
      only: "dir",
    },
  );
}

/**
 * Removes what the options of a subject spec switch off from a Claude Code export: hook configuration, agent
 * definitions, and skill links that the generic skill filter cannot see.
 * @param root - The export, which is a copy; the source is never touched.
 * @param options - The options of the subject spec.
 * @returns The names of the agents and skills that were removed.
 * @throws {UsageError} When a manifest or settings file that holds hooks or agents is not a JSON object.
 */
export function stripClaudeCode(
  root: string,
  options: SubjectOptions,
): Stripped {
  if (options.hooks !== undefined) removeHooks(root);
  return {
    agents:
      options.agents === undefined ? [] : removeAgents(root, options.agents),
    skills:
      options.skills === undefined
        ? []
        : removeSkillLinks(root, options.skills),
  };
}
