import path from "node:path";
import { plugin } from "./plant.js";
import type { Sandbox } from "./sandbox.js";

const SKIP_EMPTY_AND_SKILL = 2;

/** A case, as the tests of several cases directories plant it. */
export interface Planted {
  kind?: string;
  targets?: string[];
  checks: unknown[];
}

/**
 * Plants cases under one directory of the sandbox.
 * @param box - The sandbox.
 * @param root - The directory's name under the sandbox root, which becomes the prefix of the ids when there are two.
 * @param cases - Each case by id.
 * @returns The absolute path of the directory.
 */
export function plantRoot(
  box: Sandbox,
  root: string,
  cases: Record<string, Planted>,
): string {
  for (const [id, { checks, ...keys }] of Object.entries(cases)) {
    box.write(`${root}/${id}/prompt.md`, "Do the task.\n");
    box.write(`${root}/${id}/case.json`, { ...keys, checks });
  }
  return path.join(box.root, root);
}

/**
 * Plants a plugin whose skill `bro` loads on every run of the fake harness.
 * @param box - The sandbox.
 * @returns The plugin directory, to pass as `--subject`.
 */
export const broKit = (box: Sandbox): string =>
  plugin(box, "kit", { skill: "bro" });

/**
 * Builds the checks of a case that expects a skill to load.
 * @param skill - The skill's name.
 * @returns The check.
 */
export const loads = (skill: string): unknown[] => [
  { type: "skill_loaded", skill },
];

/**
 * Builds the checks of a case that expects a skill to load but never passes under the fake harness, which loads it
 * with the skill tool and by reading a file, never with a shell command.
 * @param skill - The skill's name.
 * @returns The check.
 */
export const misses = (skill: string): unknown[] => [
  { type: "skill_loaded", skill, via: "shell_read" },
];

/**
 * Builds the checks of a case that expects a skill to stay unloaded.
 * @param skill - The skill's name.
 * @returns The check.
 */
export const stays = (skill: string): unknown[] => [
  { type: "skill_not_loaded", skill },
];

/**
 * Finds the line of the trigger table for one skill in a markdown report.
 * @param stdout - The report.
 * @param skill - The skill's name.
 * @returns The row's cells after the skill's name; an empty list when the table has no such row.
 */
export function triggerCellsIn(stdout: string, skill: string): string[] {
  const row = stdout
    .split("\n")
    .find((line) => line.startsWith(`| ${skill} |`) && line.includes("run"));
  return row === undefined
    ? []
    : row
        .split("|")
        .slice(SKIP_EMPTY_AND_SKILL, -1)
        .map((cell) => cell.trim());
}
