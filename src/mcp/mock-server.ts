#!/usr/bin/env node
// The mock MCP server: `skill-evals-mcp-mock <server> <directory>`. It speaks the Model Context Protocol over standard
// input and output as JSON-RPC 2.0, one message per line, and answers `tools/call` from the `<tool>.json` files of the
// directory. This file imports nothing of this package at run time, so that Node can run it as it is, from the sources
// and from the compiled package alike.
import fs from "node:fs";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import type { McpAnswer, McpCall, McpTool } from "./types.js";

/**
 * The protocol versions the mock knows, newest first. They are the versions that the MCP client inside Claude Code
 * 2.1.330 lists as its own (see `docs/design/mcp-mocks.md`).
 */
export const PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
];

const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INVALID_REQUEST = -32600;
const PARSE_ERROR = -32700;
const SERVER_VERSION = "1.0.0";
const USAGE = 2;
const INVALID = "Invalid Request";
const PLACEHOLDER = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

/** What a mock server serves: its name and its tools by name. */
export interface ServerSpec {
  name: string;
  tools: Record<string, McpTool>;
}

/** A JSON-RPC message the server writes back. */
type Reply = Record<string, unknown>;

/**
 * Writes an argument's value as the text a placeholder or a pattern sees.
 * @param value - An argument of a call.
 * @returns A string as it is; a number or boolean as `String` gives it; anything else as JSON.
 */
export function argumentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

/**
 * Tells whether a response's `when` fits the arguments of a call.
 * @param when - Argument name to a regular expression; absent fits every call.
 * @param args - The call's arguments.
 * @returns True when every named argument is present and its text matches its expression.
 */
function fits(
  when: Record<string, string> | undefined,
  args: Record<string, unknown>,
): boolean {
  return Object.entries(when ?? {}).every(([name, pattern]) => {
    const value = args[name];
    return (
      Object.hasOwn(args, name) &&
      value !== undefined &&
      new RegExp(pattern).exec(argumentText(value)) !== null
    );
  });
}

/**
 * Fills the `{{argument}}` placeholders of a text.
 * @param text - A response's text.
 * @param args - The call's arguments.
 * @returns The filled text, or the names of the placeholders whose argument the call did not give.
 */
function fill(
  text: string,
  args: Record<string, unknown>,
): { text: string } | { missing: string[] } {
  const missing: string[] = [];
  const filled = text.replace(PLACEHOLDER, (_all, name: string) => {
    if (Object.hasOwn(args, name) && args[name] !== undefined) {
      return argumentText(args[name]);
    }
    missing.push(name);
    return "";
  });
  return missing.length > 0 ? { missing } : { text: filled };
}

/**
 * Chooses and fills the response to a call.
 * @param tool - The tool's file.
 * @param args - The call's arguments.
 * @returns The first response that fits, with its placeholders filled; an error answer `no response matches` when none
 *   fits, and an error answer that names the argument when a placeholder's argument is missing.
 */
export function respond(
  tool: McpTool,
  args: Record<string, unknown>,
): McpAnswer {
  const chosen = tool.responses.find((response) => fits(response.when, args));
  if (!chosen) return { text: "no response matches", isError: true };
  const filled = fill(chosen.text, args);
  if ("missing" in filled) {
    return {
      text: `missing argument ${filled.missing.map((name) => `"${name}"`).join(", ")}`,
      isError: true,
    };
  }
  return { text: filled.text, isError: chosen.isError ?? false };
}

/**
 * Builds a JSON-RPC error reply.
 * @param id - The request's id; null when the request had none that could be read.
 * @param code - The JSON-RPC error code.
 * @param message - What went wrong.
 * @returns The reply.
 */
const failure = (id: unknown, code: number, message: string): Reply => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

/**
 * Answers `initialize`.
 * @param spec - The server.
 * @param params - The request's params.
 * @returns The result: the protocol version the client asked for when the mock knows it, else the mock's latest.
 */
function initialize(spec: ServerSpec, params: unknown): Reply {
  const asked = (params as { protocolVersion?: unknown } | null)
    ?.protocolVersion;
  const known = PROTOCOL_VERSIONS.find((version) => version === asked);
  return {
    protocolVersion: known ?? PROTOCOL_VERSIONS[0],
    capabilities: { tools: {} },
    serverInfo: {
      name: spec.name,
      version: SERVER_VERSION,
    },
  };
}

/**
 * Answers `tools/call`.
 * @param spec - The server.
 * @param params - The request's params: the tool's name and its arguments.
 * @param record - Receives the call that was answered.
 * @returns The result, or null when the params name no tool of the server.
 */
function callTool(
  spec: ServerSpec,
  params: unknown,
  record: (call: McpCall) => void,
): Reply | null {
  const { name, arguments: given } = Object(params) as {
    name?: unknown;
    arguments?: unknown;
  };
  const tool =
    typeof name === "string" && Object.hasOwn(spec.tools, name)
      ? spec.tools[name]
      : undefined;
  if (tool === undefined || typeof name !== "string") return null;
  const args =
    given !== null && typeof given === "object" && !Array.isArray(given)
      ? (given as Record<string, unknown>)
      : {};
  const response = respond(tool, args);
  record({
    server: spec.name,
    tool: name,
    input: given ?? {},
    response,
    at: new Date().toISOString(),
  });
  return {
    content: [{ type: "text", text: response.text }],
    ...(response.isError && { isError: true }),
  };
}

/**
 * Answers one JSON-RPC request.
 * @param spec - The server.
 * @param request - The request's three parts, read from the message.
 * @param request.id - Its `id`; undefined for a notification.
 * @param request.method - Its `method`.
 * @param request.params - Its `params`.
 * @param record - Receives each call that was answered.
 * @returns The reply, or null for a notification, which gets none.
 */
function answer(
  spec: ServerSpec,
  request: { id: unknown; method: string; params: unknown },
  record: (call: McpCall) => void,
): Reply | null {
  const { id, method, params } = request;
  const notification = id === undefined;
  let result: Reply | null;
  if (method === "initialize") result = initialize(spec, params);
  else if (method === "ping") result = {};
  else if (method === "tools/list") {
    result = {
      tools: Object.entries(spec.tools).map(([name, tool]) => ({
        name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    };
  } else if (method === "tools/call") {
    // A call sent as a notification gets no reply, so it is not run: the log must hold what a client saw answered.
    if (notification) return null;
    result = callTool(spec, params, record);
    if (result === null) {
      return failure(id, INVALID_PARAMS, "unknown tool");
    }
  } else if (notification) {
    return null;
  } else {
    return failure(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
  return notification ? null : { jsonrpc: "2.0", id, result };
}

/**
 * Handles one line of input.
 * @param spec - The server.
 * @param line - One line, which should hold one JSON-RPC message.
 * @param record - Receives each call that was answered.
 * @returns The reply to write, or null when there is none: a notification, a response from the client, an empty line.
 */
export function handleLine(
  spec: ServerSpec,
  line: string,
  record: (call: McpCall) => void,
): Reply | null {
  if (line.trim() === "") return null;
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return failure(null, PARSE_ERROR, "Parse error");
  }
  if (
    message === null ||
    typeof message !== "object" ||
    Array.isArray(message)
  ) {
    return failure(null, INVALID_REQUEST, INVALID);
  }
  const { id, method, params } = message as Record<string, unknown>;
  // A request's id is a string or a number; null is not one.
  if (id === null) return failure(null, INVALID_REQUEST, INVALID);
  // A message with no method is a response to a request of the server's, which it never makes.
  if (method === undefined) return null;
  if (typeof method !== "string") {
    return failure(id ?? null, INVALID_REQUEST, INVALID);
  }
  return answer(spec, { id, method, params }, record);
}

/**
 * Reads a server's tools from a directory of `<tool>.json` files.
 * @param name - The server's name, which the log and `serverInfo` carry.
 * @param dir - The directory; a run's staged copy of the server's directory.
 * @returns The server, with each tool named after its file.
 * @throws {Error} When a file cannot be read or is not JSON.
 */
export function readServer(name: string, dir: string): ServerSpec {
  const tools = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file): [string, McpTool] => [
      file.slice(0, -".json".length),
      JSON.parse(fs.readFileSync(`${dir}/${file}`, "utf8")) as McpTool,
    ]);
  return { name, tools: Object.fromEntries(tools) };
}

/** Where a server reads from and writes to. */
export interface Streams {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

/**
 * Serves a server until its input ends.
 * @param spec - The server.
 * @param streams - Where the messages come from and go to.
 * @param log - The file that gets one line for each call answered; absent: no log.
 * @returns A promise that settles when the input has ended and every line has been answered.
 */
export function serve(
  spec: ServerSpec,
  streams: Streams,
  log: string | undefined,
): Promise<void> {
  const record = (call: McpCall): void => {
    if (log !== undefined) fs.appendFileSync(log, `${JSON.stringify(call)}\n`);
  };
  const lines = readline.createInterface({ input: streams.input });
  lines.on("line", (line) => {
    const reply = handleLine(spec, line, record);
    if (reply !== null) streams.output.write(`${JSON.stringify(reply)}\n`);
  });
  return new Promise((resolve) => {
    lines.on("close", resolve);
  });
}

/**
 * Starts the server the command line names.
 * @param argv - The server's name and the directory of its tool files.
 * @param env - The environment; `CALLS_LOG` names the log file.
 * @param streams - Where the messages come from and go to. Default: standard input and output.
 * @returns The exit code: 0 after the input ended, 2 for a command line that does not name a server and a directory.
 */
export async function main(
  argv: string[],
  env: Record<string, string | undefined>,
  streams: Streams = { input: process.stdin, output: process.stdout },
): Promise<number> {
  const [name, dir] = argv;
  if (name === undefined || dir === undefined) {
    process.stderr.write("usage: server <name> <directory>\n");
    return USAGE;
  }
  await serve(readServer(name, dir), streams, env["CALLS_LOG"]);
  return 0;
}

/** The index of the first argument after the paths of node and of this script. */
const FIRST_ARGUMENT = 2;

if (
  process.argv[1] !== undefined &&
  fs.realpathSync(process.argv[1]) ===
    fs.realpathSync(fileURLToPath(import.meta.url))
) {
  process.exitCode = await main(
    process.argv.slice(FIRST_ARGUMENT),
    process.env,
  );
}
