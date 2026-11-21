import fs from "node:fs";
import path from "node:path";
import type { Harness, ToolKind } from "./shared.js";
import {
  jsonLines,
  opt,
  placeSkills,
  pluginDir,
  sumTokens,
  toolCall,
} from "./shared.js";

const KINDS: Record<string, ToolKind> = {
  bash: "shell",
  read: "read",
  write: "write",
  edit: "edit",
  patch: "edit",
  grep: "search",
  glob: "search",
  list: "search",
  webfetch: "web",
  websearch: "web",
  skill: "skill",
  task: "subagent",
};

/** The events of `opencode run --format json` that the adapter reads. */
type Event =
  | { type: "step_start" }
  | {
      type: "step_finish";
      part: {
        cost?: number;
        tokens: {
          input: number;
          output: number;
          cache: { read: number; write: number };
        };
      };
    }
  | { type: "text"; part: { text: string } }
  | { type: "tool_use"; part: { tool: string; state?: { input?: unknown } } }
  | { type: "error"; error?: { name?: string; data?: { message?: string } } };

const opencode: Harness = {
  id: "opencode",
  bin: "opencode",
  authFiles: [".local/share/opencode/auth.json"],

  invocation({ subject, home, workspace, prompt, model }) {
    const configDir = path.join(home, ".config", "opencode");
    fs.mkdirSync(configDir, { recursive: true });
    // V1 reads "plugin" and ignores "plugins" (seen on 1.19.6); V2 is documented to read "plugins".
    const plugin = pluginDir(subject);
    const plugins = plugin ? [plugin] : [];
    fs.writeFileSync(
      path.join(configDir, "opencode.json"),
      JSON.stringify({ plugin: plugins, plugins }),
    );
    placeSkills(subject, path.join(home, ".agents", "skills"));
    return {
      args: [
        "run",
        "--format",
        "json",
        "--auto",
        "--dir",
        workspace,
        ...opt("-m", model),
        "--",
        prompt,
      ],
      env: {},
    };
  },

  parse(stdout) {
    const events = jsonLines(stdout) as Event[];
    const steps = events
      .filter((e) => e.type === "step_finish")
      .map((e) => e.part);
    const failure = events.find((e) => e.type === "error")?.error;
    const unfinished = steps.length ? null : "no step_finish event";
    return {
      finalText: events
        .slice(events.map((e) => e.type).lastIndexOf("step_start") + 1)
        .filter((e) => e.type === "text")
        .map((e) => e.part.text)
        .join(""),
      toolCalls: events
        .filter((e) => e.type === "tool_use")
        .map((e) => toolCall(KINDS, e.part.tool, e.part.state?.input)),
      tokens: sumTokens(
        steps.map(({ tokens }) => ({
          input: tokens.input + tokens.cache.read + tokens.cache.write,
          output: tokens.output,
        })),
      ),
      costUsd: steps.length
        ? steps.reduce((total, step) => total + (step.cost ?? 0), 0)
        : null,
      loaded: { paths: null, skills: null },
      error: failure
        ? failure.data?.message || failure.name || "error"
        : unfinished,
    };
  },
};

export default opencode;
