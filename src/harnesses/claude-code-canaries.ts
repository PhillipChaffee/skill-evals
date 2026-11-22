import path from "node:path";
import type { Harness } from "./shared.js";

// What a person edits to change Claude Code, under its configuration directory.
const EDITED = [
  "settings.json",
  "settings.local.json",
  "CLAUDE.md",
  "agents",
  "skills",
  "commands",
  "hooks",
  "plugins/installed_plugins.json",
];

/**
 * Names what a run of Claude Code must not change in the operator's real directory: the files a person edits, and the
 * MCP servers and tool permissions of `.claude.json`. Never the login (`.credentials.json`), and not the history and
 * caches that a live session rewrites every turn.
 * @param env - The operator's environment; `CLAUDE_CONFIG_DIR` moves both the directory and `.claude.json`.
 * @returns The paths, relative to the home unless `CLAUDE_CONFIG_DIR` is set.
 */
export const claudeCanaries: NonNullable<Harness["canaries"]> = (env) => {
  const moved = env["CLAUDE_CONFIG_DIR"];
  const dir = moved ?? ".claude";
  return [
    ...EDITED.map((name) => ({ path: path.join(dir, name) })),
    {
      path: moved ? path.join(moved, ".claude.json") : ".claude.json",
      json: ["mcpServers", "projects.*.mcpServers", "projects.*.allowedTools"],
    },
  ];
};
