import fs from "node:fs";
import path from "node:path";
import type { FakeScript } from "./plant.js";
import { script } from "./plant.js";
import type { Sandbox } from "./sandbox.js";

const GET_ISSUE_INPUT = {
  name: "mcp__tracker__get_issue",
  input: { id: "SHOP-7" },
};

/** One step of a scripted agent. */
export type Step = FakeScript["turns"][number][number];

/** The tool call that reads one issue of the planted `tracker` server, as a scripted agent makes it. */
export const GET_ISSUE: Step = { call: GET_ISSUE_INPUT };

/** The same call, made but never stated by the harness: only the mock log shows it. */
export const HIDDEN_ISSUE: Step = {
  call: { ...GET_ISSUE_INPUT, hidden: true },
};

/** A step that edits the script of the mock server, with no call made. */
export const TAMPERED_SERVER: Step = {
  call: { name: "Bash", input: { command: "true" }, tamperServer: true },
};

/** A step that writes a line for a `get_issue` call into the tracker's mock log, with no call made. */
export const FORGED_ISSUE: Step = {
  call: {
    name: "Bash",
    input: { command: "true" },
    forgeLog: { server: "tracker", tool: "get_issue", input: { id: "SHOP-7" } },
  },
};

/** The checks of the planted case: a call to the tracker, and the word `done`. */
const LOOKUP_CHECKS = [
  { type: "tool_called", kind: "mcp", name: "^tracker\\.get_issue$", min: 1 },
  { type: "output_contains", text: "done" },
];

/** A tool file that loads. */
export const TOOL = {
  description: "d",
  inputSchema: { type: "object" },
  responses: [{ text: "t" }],
};

/** What a test plants besides the steps of the agent. */
interface More {
  /** The case's checks. Default: `LOOKUP_CHECKS`. */
  checks?: unknown[];
  /** Fields of the init event of the scripted harness. */
  init?: FakeScript["init"];
}

/**
 * Plants a case `lookup` with a `tracker` server, and the script of an agent that does the given steps.
 * @param box - The sandbox.
 * @param steps - What the agent does. Default: one `get_issue` call.
 * @param more - The case's checks and the init event.
 * @returns The cases directory.
 */
export function plantLookup(
  box: Sandbox,
  steps: Step[] = [GET_ISSUE],
  more: More = {},
): string {
  box.write("cases/lookup/prompt.md", "look up the issue\n");
  box.write("cases/lookup/case.json", {
    checks: more.checks ?? LOOKUP_CHECKS,
  });
  box.write("cases/lookup/mcp/tracker/get_issue.json", {
    description: "Read one issue.",
    inputSchema: { type: "object" },
    responses: [
      { when: { id: "^SHOP-7$" }, text: "{{id}}: Cart empties on login." },
    ],
  });
  script(box, "lookup", {
    match: { prompt: "look up" },
    ...(more.init && { init: more.init }),
    turns: [[...steps, { final: "done" }]],
  });
  return path.join(box.root, "cases");
}

/** What the fake harness saw of its own surroundings when it was started with `--mcp-config`. */
export interface Seen {
  argv: string[];
  configFile: string;
  config: string;
  cwd: string;
  home: string;
  files: string[];
  env: string[];
}

/** The config the fake harness read, as Claude Code's `--mcp-config` file has it. */
export interface McpConfig {
  mcpServers: Record<
    string,
    {
      type: string;
      command: string;
      args: string[];
      env: Record<string, string>;
    }
  >;
}

/**
 * Reads what the fake harness recorded of its start.
 * @param box - The sandbox whose fake harness ran.
 * @returns The record, with the config parsed by `configOf`.
 */
export const seenBy = (box: Sandbox): Seen =>
  JSON.parse(
    fs.readFileSync(path.join(box.root, "fake/mcp-seen.json"), "utf8"),
  ) as Seen;

/**
 * Parses the config the fake harness was given.
 * @param seen - What the fake harness recorded of its start.
 * @returns The servers of the config file, by name.
 */
export const configOf = (seen: Seen): McpConfig =>
  JSON.parse(seen.config) as McpConfig;

/**
 * Tells whether a path is a directory or below it.
 * @param dir - The directory that may hold it.
 * @param file - The path that may lie below it.
 * @returns True when `file` is `dir` or lies below it.
 */
export function inside(dir: string, file: string): boolean {
  const relative = path.relative(dir, file);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}
