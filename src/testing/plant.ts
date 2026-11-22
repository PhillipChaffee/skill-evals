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

/** The `system` `init` event that opens a Claude Code stream, as far as the fake harness fills it. */
interface InitEvent {
  type: "system";
  subtype: "init";
  model: string;
  plugins: { name: string; path: string }[];
  skills: string[];
  agents: string[];
  mcp_servers: { name: string }[];
  tools: string[];
}

/** A tool call of the scripted agent. */
type FakeCall = {
  call: {
    name: string;
    /** Every string in it may hold `$PLUGIN_DIR` (the plugin directory the harness was given) and `$CONFIG_DIR` (the run's config directory, where skill copies are placed). */
    input: unknown;
    /** The tool result; empty when absent. */
    output?: string;
    /** Runs `input.command` in the workspace and uses its real combined output and exit status as the result. */
    exec?: boolean;
    /** A file to create in the workspace. */
    write?: { path: string; content: string };
    /** Marks the tool result as an error without running anything; with `exec`, the command's exit status decides. */
    isError?: boolean;
  };
};

/** An `Agent` call, then its steps, each marked as the child of that call. */
type FakeAgent = {
  agent: {
    type: string;
    prompt: string;
    /** The dispatch's `model` field. */
    model?: string;
    steps: FakeStep[];
  };
};

/** One thing the scripted agent does. */
type FakeStep =
  | { text: string; usage?: Record<string, number> }
  | FakeCall
  /** Calls and dispatches that share one assistant message. */
  | { parallel: (FakeCall | FakeAgent)[] }
  | FakeAgent
  | {
      hook: { event: string; command: string; exit: number; context?: string };
    }
  /** Ends the run with an error. */
  | { fail: string }
  /** Sets the final text of the run. */
  | { final: string };

/** A transcript for the fake harness to play, in place of its default behaviour. */
export interface FakeScript {
  /** What a run must fit for this script to play. The first script that fits is used; no `match` fits every run. */
  match?: { prompt?: string; plugin?: boolean };
  /** Fields of the opening `init` event to replace. */
  init?: Partial<InitEvent>;
  /** Names of init fields to leave out. */
  initOmit?: (keyof InitEvent)[];
  /** Leaves the init event out of the stream. */
  noInit?: boolean;
  /** A skill that an account syncs into the config directory during the run, as `synced/org/<name>`. */
  syncSkill?: string;
  /** The steps of each turn; turn n answers the n-th prompt of a session. */
  turns: FakeStep[][];
}

/**
 * Writes a script for the fake harness to play. Scripts are tried in the order of their names.
 * @param box - Where to write it.
 * @param name - The script's file name, without the extension.
 * @param transcript - What the agent does.
 * @returns The script's file.
 */
export const script = (
  box: Sandbox,
  name: string,
  transcript: FakeScript,
): string => box.write(`fake/scripts/${name}.json`, transcript);
