import fs from "node:fs";
import path from "node:path";
import type { Case } from "./cases.js";
import type { History } from "./history-types.js";

/** A piece of what the agent reads, with the place to name it by. */
export interface Source {
  where: string;
  text: string;
  /** True for a name (of a file, a tool or a session), which is read in segments as a path is. */
  name?: boolean;
}

/**
 * Collects every string of a JSON value, keys included.
 * @param value - Parsed JSON.
 * @returns The strings, in document order.
 */
function stringsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, one]) => [
      key,
      ...stringsOf(one),
    ]);
  }
  return [];
}

/**
 * Lists the texts of a conversation that already happened.
 * @param history - The messages.
 * @param where - Names the conversation.
 * @returns Each message's text, and each tool call's name, input and output. A call's name and input hold identifiers, and
 *   are read as names are, in segments.
 */
function historySources(history: History, where: string): Source[] {
  return history.flatMap((message, index) => [
    { where: `${where}, message ${String(index + 1)}`, text: message.text },
    ...(message.toolCalls ?? []).flatMap((call) =>
      stringsOf([call.name, call.input, call.output]).map((text) => ({
        where: `${where}, a tool call of message ${String(index + 1)}`,
        text,
      })),
    ),
  ]);
}

/**
 * Lists what the user says in the case.
 * @param caseDef - A loaded case, which may be one variant of a case file.
 * @returns The prompt, or each turn's message, with the arguments of a user invocation. The names of skills are the
 *   subject's and are left out.
 */
function promptSources(caseDef: Case): Source[] {
  if (caseDef.turns === null) {
    return [{ where: "the prompt", text: caseDef.prompt }];
  }
  return caseDef.turns.flatMap((turn, index): Source[] => {
    const where = `turn ${String(index + 1)}`;
    if ("prompt" in turn) return [{ where, text: turn.prompt }];
    if ("reply" in turn) {
      return [{ where: `${where} (a reply)`, text: turn.reply.prompt }];
    }
    if ("invoke" in turn && turn.invoke.args !== undefined) {
      return [{ where: `${where} (an invocation)`, text: turn.invoke.args }];
    }
    return [];
  });
}

/**
 * Lists the texts of the case's mock MCP servers: the names, tool descriptions, input schemas and response texts.
 * @param dir - The case's `mcp/` directory.
 * @returns The texts. A file that cannot be read is left out; loading checked it.
 */
function mcpSources(dir: string): Source[] {
  return fs.readdirSync(dir).flatMap((server) =>
    fs.readdirSync(path.join(dir, server)).flatMap((file): Source[] => {
      const where = `mcp/${server}/${file}`;
      let tool: {
        description?: unknown;
        inputSchema?: unknown;
        responses?: { text?: unknown }[];
      };
      try {
        tool = JSON.parse(
          fs.readFileSync(path.join(dir, server, file), "utf8"),
        ) as typeof tool;
      } catch {
        return [];
      }
      return [
        {
          where: `the name of ${where}`,
          text: `${server}/${file}`,
          name: true,
        },
        ...stringsOf(tool.description).map((text) => ({
          where: `the description of ${where}`,
          text,
        })),
        ...stringsOf(tool.inputSchema).map((text) => ({
          where: `the input schema of ${where}`,
          text,
          name: true,
        })),
        ...(tool.responses ?? []).flatMap((response) =>
          stringsOf(response.text).map((text) => ({
            where: `a response of ${where}`,
            text,
          })),
        ),
      ];
    }),
  );
}

/**
 * Lists every text of a case that the agent reads: what the user says, the conversation and earlier sessions that are
 * seeded, and the mock servers. Subject content (skill names, rules, agent definitions) and the judge's prompt are not
 * the case's, and are left out.
 * @param caseDef - A loaded case, which may be one variant of a case file.
 * @returns The texts, each with where it is.
 */
export function agentSources(caseDef: Case): Source[] {
  return [
    ...promptSources(caseDef),
    ...historySources(caseDef.history ?? [], "history.json"),
    ...(caseDef.sessions ?? []).flatMap((session) => [
      ...(session.cwd === undefined
        ? []
        : [{ where: `session ${session.id}`, text: session.cwd, name: true }]),
      ...historySources(session.messages, `session ${session.id}`),
    ]),
    ...(caseDef.mcp === undefined ? [] : mcpSources(caseDef.mcp.dir)),
  ];
}
