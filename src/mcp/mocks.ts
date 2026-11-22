import fs from "node:fs";
import path from "node:path";
import { UsageError } from "../scope.js";
import type { McpResponse, McpSource, McpTool } from "./types.js";
import { MCP_NAME } from "./types.js";

const JSON_FILE = ".json";
const TOOL_KEYS = ["description", "inputSchema", "responses"];
const RESPONSE_KEYS = ["when", "text", "isError"];

/**
 * Tells whether a value is a plain object.
 * @param value - Any parsed JSON value.
 * @returns True for an object that is neither null nor a list.
 */
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Checks that an object has no key besides the known ones.
 * @param given - The parsed object.
 * @param known - The keys it may have.
 * @param where - Names the file and the place in it, for the message.
 * @throws {UsageError} Naming the first unknown key and the keys that are allowed.
 */
function requireKnownKeys(
  given: Record<string, unknown>,
  known: string[],
  where: string,
): void {
  const unknown = Object.keys(given).find((key) => !known.includes(key));
  if (unknown !== undefined) {
    throw new UsageError(
      `${where}: unknown key "${unknown}"; allowed: ${known.join(", ")}`,
    );
  }
}

/**
 * Reads the `when` of a response: argument names with patterns that must compile.
 * @param value - The parsed value.
 * @param where - Names the file and the response, for the message.
 * @returns The map.
 * @throws {UsageError} When it is no object of strings, or a pattern is not a regular expression.
 */
function readWhen(value: unknown, where: string): Record<string, string> {
  if (!isObject(value)) {
    throw new UsageError(
      `${where}: "when" must be an object of argument names to regular expressions`,
    );
  }
  return Object.fromEntries(
    Object.entries(value).map(([name, pattern]) => {
      if (typeof pattern !== "string") {
        throw new UsageError(
          `${where}: when.${name} must be a regular expression, as a string`,
        );
      }
      try {
        new RegExp(pattern);
      } catch (error) {
        throw new UsageError(
          `${where}: when.${name} is not a regular expression: ${(error as Error).message}`,
        );
      }
      return [name, pattern];
    }),
  );
}

/**
 * Reads one response of a tool.
 * @param value - The parsed value.
 * @param where - Names the file and the response, for the message.
 * @returns The response as the mock server will use it, with `isError` left out when the file does.
 * @throws {UsageError} For an unknown key, a missing or non-string `text`, a non-boolean `isError`, or a bad `when`.
 */
function readResponse(value: unknown, where: string): McpResponse {
  if (!isObject(value)) {
    throw new UsageError(`${where}: a response must be an object`);
  }
  requireKnownKeys(value, RESPONSE_KEYS, where);
  const { when, text, isError } = value;
  if (typeof text !== "string") {
    throw new UsageError(`${where}: "text" must be a string`);
  }
  if (isError !== undefined && typeof isError !== "boolean") {
    throw new UsageError(`${where}: "isError" must be true or false`);
  }
  return {
    ...(when !== undefined && { when: readWhen(when, where) }),
    text,
    ...(isError !== undefined && { isError }),
  };
}

/**
 * Reads the content of one tool file.
 * @param text - The file's text.
 * @param where - Names the file, for the message.
 * @returns The tool, with every response checked.
 * @throws {UsageError} When the file is not JSON or does not have the shape of `McpTool`; unknown keys are errors.
 */
function readTool(text: string, where: string): McpTool {
  let given: unknown;
  try {
    given = JSON.parse(text);
  } catch (error) {
    throw new UsageError(`${where}: ${(error as Error).message}`);
  }
  if (!isObject(given)) throw new UsageError(`${where}: must be an object`);
  requireKnownKeys(given, TOOL_KEYS, where);
  const { description, inputSchema, responses } = given;
  if (typeof description !== "string") {
    throw new UsageError(`${where}: "description" must be a string`);
  }
  if (!isObject(inputSchema)) {
    throw new UsageError(`${where}: "inputSchema" must be an object`);
  }
  if (!Array.isArray(responses) || responses.length === 0) {
    throw new UsageError(`${where}: "responses" must be a non-empty list`);
  }
  return {
    description,
    inputSchema,
    responses: responses.map((one: unknown, index) =>
      readResponse(one, `${where} responses[${String(index)}]`),
    ),
  };
}

/**
 * Checks one server's directory.
 * @param dir - The server's directory.
 * @param where - Names the server for a message, as `<file>: mcp/<server>`.
 * @throws {UsageError} When it holds anything but regular `<tool>.json` files with valid names and valid content, or none.
 */
function checkServer(dir: string, where: string): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  if (entries.length === 0) {
    throw new UsageError(`${where}: holds no tool files`);
  }
  for (const entry of entries) {
    const tool = entry.name.endsWith(JSON_FILE)
      ? entry.name.slice(0, -JSON_FILE.length)
      : "";
    if (!entry.isFile() || !MCP_NAME.test(tool)) {
      throw new UsageError(
        `${where}/${entry.name}: only regular files named <tool>.json are allowed, with a tool name that matches ${String(MCP_NAME)}; links are not followed`,
      );
    }
    readTool(
      fs.readFileSync(path.join(dir, entry.name), "utf8"),
      `${where}/${entry.name}`,
    );
  }
}

/**
 * Loads the mock MCP servers of a case: `mcp/<server>/<tool>.json`.
 * @param caseDir - The case's directory.
 * @param file - The case file, for an error message.
 * @returns The servers, or null when the case has no `mcp/` directory.
 * @throws {UsageError} When `mcp` is not a directory or is a link or holds none; a server name does not match
 *   `^[a-z][a-z0-9_-]*$` or holds `__`; anything in a server's directory is not a regular `<tool>.json` file; or a
 *   tool file is invalid: not JSON, an unknown key, a missing field, a `when` that is no regular expression.
 */
export function loadMcp(caseDir: string, file: string): McpSource | null {
  const dir = path.join(caseDir, "mcp");
  let found: fs.Stats;
  try {
    found = fs.lstatSync(dir);
  } catch {
    return null;
  }
  if (!found.isDirectory()) {
    throw new UsageError(
      `${file}: mcp must be a directory, not a link or file`,
    );
  }
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  if (entries.length === 0) {
    throw new UsageError(`${file}: mcp/ holds no server`);
  }
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      !MCP_NAME.test(entry.name) ||
      entry.name.includes("__")
    ) {
      throw new UsageError(
        `${file}: mcp/${entry.name} must be a directory named like ${String(MCP_NAME)}, without "__"`,
      );
    }
    checkServer(path.join(dir, entry.name), `${file}: mcp/${entry.name}`);
  }
  return { dir, servers: entries.map((entry) => entry.name).sort() };
}
