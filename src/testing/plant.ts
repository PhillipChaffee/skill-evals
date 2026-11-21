import path from "node:path";
import type { Sandbox } from "./sandbox.js";

/** What a fake plugin tells the fake harness to do, through its `behavior.json`. */
export interface Behavior {
  /** What the run reports as its cost. */
  costUsd?: number;
  /** A skill of the plugin that the agent loads on every run. */
  skill?: string;
  /** Makes the harness report some other plugin directory as loaded. */
  ghost?: boolean;
  /** The agent's final text, in place of its report of what it saw. */
  answer?: string;
}

/**
 * Writes a plugin directory for the fake harness.
 * @param box - Where to write it.
 * @param name - The folder name, which the plugin's `out/summary.txt` repeats.
 * @param behavior - What the agent does when the plugin is loaded.
 * @returns The plugin directory.
 */
export function plugin(box: Sandbox, name: string, behavior: Behavior): string {
  box.write(`${name}/.claude-plugin/plugin.json`, { name });
  box.write(`${name}/behavior.json`, { name, ...behavior });
  return path.join(box.root, name);
}

/**
 * Writes a plain folder of skills.
 * @param box - Where to write it.
 * @param name - Names the folder under the sandbox root.
 * @param skills - Skill name to the text of its SKILL.md.
 * @returns The absolute path of what was written.
 */
export function skillsFolder(
  box: Sandbox,
  name: string,
  skills: Record<string, string>,
): string {
  for (const [skill, text] of Object.entries(skills)) {
    box.write(`${name}/${skill}/SKILL.md`, text);
  }
  return path.join(box.root, name);
}

/**
 * Writes one case, with a workspace that holds `notes.txt`.
 * @param box - Where to write it.
 * @param checks - Written as they are, so a test can plant ones that loading must reject.
 * @param more - Other keys of its case file, such as `minScore`.
 * @returns The cases directory, which holds the one case `restate`.
 */
export function plantCase(
  box: Sandbox,
  checks: unknown,
  more: Record<string, unknown> = {},
): string {
  box.write("cases/restate/prompt.md", "say it in plain words\n");
  box.write("cases/restate/case.json", { checks, ...more });
  box.write("cases/restate/workspace/notes.txt", "planted\n");
  return path.join(box.root, "cases");
}
