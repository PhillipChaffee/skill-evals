import fs from "node:fs";
import path from "node:path";
import { UsageError } from "../scope.js";
import { matches } from "../subject-options.js";
import type { SubjectOptions } from "../subject-options.js";
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
 * Removes a file that a manifest names, when it lies inside the export.
 * @param root - The export.
 * @param named - The path as the manifest writes it.
 */
function removeNamed(root: string, named: string): void {
  const file = path.resolve(root, named);
  if (file.startsWith(`${path.resolve(root)}${path.sep}`)) {
    fs.rmSync(file, { force: true });
  }
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
 * Tells whether an agent file or name is removed.
 * @param agents - The `agents` option.
 * @param file - An agent's file or the path the manifest names.
 * @returns True for every agent under `off`, and for one whose name matches the glob of `except`.
 */
function removed(
  agents: NonNullable<SubjectOptions["agents"]>,
  file: string,
): boolean {
  return agents === "off" || matches(agents.except, path.basename(file, ".md"));
}

/**
 * Removes agent definitions: the Markdown files of `agents/` and `.claude/agents/`, and their entries in the manifest.
 * @param root - The export.
 * @param agents - The `agents` option.
 */
function removeAgents(
  root: string,
  agents: NonNullable<SubjectOptions["agents"]>,
): void {
  for (const dir of AGENT_DIRS) {
    if (!fs.existsSync(path.join(root, dir))) continue;
    walkTree(root, {
      from: dir,
      visit: ({ file, dirent }) => {
        if (dirent.isFile() && file.endsWith(".md") && removed(agents, file)) {
          fs.rmSync(file);
        }
        return undefined;
      },
    });
  }
  const file = path.join(root, MANIFEST);
  const manifest = readObject(file);
  if (manifest === null || !("agents" in manifest)) return;
  const left = pathsOf(manifest["agents"]).filter(
    (named) => !removed(agents, named),
  );
  if (left.length === 0) delete manifest["agents"];
  else manifest["agents"] = left;
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, INDENT)}\n`);
}

/**
 * Removes what the options of a subject spec switch off from a Claude Code export: hook configuration and agent
 * definitions. Skills and rules are not Claude Code's to remove; the generic code handles them.
 * @param root - The export, which is a copy; the source is never touched.
 * @param options - The options of the subject spec.
 * @throws {UsageError} When a manifest or settings file that holds hooks or agents is not a JSON object.
 */
export function stripClaudeCode(root: string, options: SubjectOptions): void {
  if (options.hooks !== undefined) removeHooks(root);
  if (options.agents !== undefined) removeAgents(root, options.agents);
}
