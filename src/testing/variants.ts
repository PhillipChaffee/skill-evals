import fs from "node:fs";
import path from "node:path";
import claudeCode from "../harnesses/claude-code.js";
import type { Subject } from "../subject.js";
import { resolveSubject } from "../subject.js";
import { plugin } from "./plant.js";
import type { Sandbox } from "./sandbox.js";

/** A check that a run passes only when the plugin's skill `bro` loaded. */
export const BRO_LOADED = { type: "skill_loaded", skill: "bro" };

/** A check that every run of the fake harness passes: it writes `out/summary.txt`. */
export const SUMMARY_CHECK = {
  type: "file_matches",
  path: "out/summary.txt",
  pattern: "summary",
};

/**
 * Writes a plugin with a skill, two hooks configurations, a settings file and two agents.
 * @param box - The sandbox.
 * @param name - The folder name.
 * @returns The plugin directory.
 */
export function ruggedKit(box: Sandbox, name = "kit"): string {
  const dir = plugin(box, name, { skill: "bro", reportAgents: true });
  box.write(`${name}/.claude-plugin/plugin.json`, {
    name,
    version: "1.0.0",
    hooks: "./hooks/extra.json",
    agents: ["./agents/reviewer.md", "./agents/helper.md"],
  });
  box.write(`${name}/hooks/hooks.json`, { hooks: { SessionStart: [] } });
  box.write(`${name}/hooks/extra.json`, { hooks: { Stop: [] } });
  box.write(`${name}/.claude/settings.json`, {
    model: "x",
    hooks: { PreToolUse: [] },
  });
  box.write(`${name}/agents/reviewer.md`, "# reviewer\n");
  box.write(`${name}/agents/helper.md`, "# helper\n");
  box.write(`${name}/skills/bro/SKILL.md`, "# bro\n");
  box.write(`${name}/skills/magic-a/SKILL.md`, "# a\n");
  box.write(`${name}/skills/magic-b/SKILL.md`, "# b\n");
  return dir;
}

/**
 * Resolves a subject the way `run` does, with Claude Code removing hooks and agents.
 * @param box - The sandbox, whose root is the project.
 * @param spec - The subject as typed, options included.
 * @param label - The subject's label. Default: "b".
 * @returns The subject; the test must dispose of it.
 */
export const resolved = (box: Sandbox, spec: string, label = "b"): Subject =>
  resolveSubject(label, spec, {
    root: box.root,
    cwd: box.root,
    isGitRepo: false,
    strippers: [claudeCode],
  });

/**
 * Reads a JSON file of a directory.
 * @param dir - The directory.
 * @param relative - The file's path in it.
 * @returns The parsed object.
 */
export const jsonIn = (
  dir: string,
  relative: string,
): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(dir, relative), "utf8")) as Record<
    string,
    unknown
  >;

/**
 * Scores the planted case against subjects given as `--subjects`.
 * @param box - The sandbox, with the case planted in `cases`.
 * @param subjects - The value of `--subjects`.
 * @param more - More flags, which come after `--reps 5` and `--out`, so they may replace them.
 * @returns The command's result, and its output directory.
 */
export async function compared(
  box: Sandbox,
  subjects: string,
  more: string[] = [],
) {
  const out = path.join(box.root, "results");
  const ran = await box.cli([
    ...["run", "--subjects", subjects, "--cases", path.join(box.root, "cases")],
    ...["--reps", "5", "--out", out, ...more],
  ]);
  return { ran, out };
}
