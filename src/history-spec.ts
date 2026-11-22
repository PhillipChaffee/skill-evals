import path from "node:path";
import type {
  History,
  HistoryCall,
  HistoryMessage,
  PriorSession,
} from "./history-types.js";
import { UsageError, isObject } from "./scope.js";

// The keys each object takes. Any other key is an error, even under `--lenient`.
const MESSAGE_KEYS = ["role", "text", "toolCalls"];
const CALL_KEYS = ["name", "input", "output"];
const SESSION_KEYS = ["id", "startedAt", "cwd", "messages"];
// A session id may name a file, so it holds no separator and no leading dot.
const SESSION_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/**
 * Checks that an object has no key that its kind does not take.
 * @param value - The object.
 * @param allowed - The keys it may have.
 * @param where - Names the file and the place in it.
 * @throws {UsageError} Naming the first unknown key and the allowed ones.
 */
function exactKeys(
  value: Record<string, unknown>,
  allowed: string[],
  where: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) {
    throw new UsageError(
      `${where}: unknown key "${unknown}"; allowed: ${allowed.join(", ")}`,
    );
  }
}

/**
 * Requires an object.
 * @param value - What the file holds there.
 * @param where - Names the file and the place in it.
 * @returns The same value, known to be an object.
 * @throws {UsageError} When it is not a plain object.
 */
function objectAt(value: unknown, where: string): Record<string, unknown> {
  if (!isObject(value)) throw new UsageError(`${where}: must be an object`);
  return value;
}

/**
 * Reads the tool calls of a message.
 * @param value - The `toolCalls` value.
 * @param where - Names the file and the message.
 * @returns The calls, each with its name, input and, when given, output.
 * @throws {UsageError} For a value that is no list, an unknown key, a missing name or input, or an output that is not text.
 */
function readCalls(value: unknown, where: string): HistoryCall[] {
  if (!Array.isArray(value)) {
    throw new UsageError(`${where}: "toolCalls" must be a list`);
  }
  return value.map((raw: unknown, index) => {
    const at = `${where} toolCalls[${String(index)}]`;
    const call = objectAt(raw, at);
    exactKeys(call, CALL_KEYS, at);
    const { name, input, output } = call;
    if (typeof name !== "string" || name === "") {
      throw new UsageError(`${at}: "name" must be a non-empty string`);
    }
    if (!("input" in call)) throw new UsageError(`${at}: "input" is missing`);
    if (output !== undefined && typeof output !== "string") {
      throw new UsageError(`${at}: "output" must be a string`);
    }
    return { name, input, ...(output === undefined ? {} : { output }) };
  });
}

/**
 * Reads one message.
 * @param raw - The value of the list's entry.
 * @param where - Names the file and the entry.
 * @returns The message, with `toolCalls` only when it has them.
 * @throws {UsageError} For an unknown key, a role other than `user` or `assistant`, text that is no string, or tool
 *   calls on a user message.
 */
function readMessage(raw: unknown, where: string): HistoryMessage {
  const message = objectAt(raw, where);
  exactKeys(message, MESSAGE_KEYS, where);
  const { role, text, toolCalls } = message;
  if (role !== "user" && role !== "assistant") {
    throw new UsageError(`${where}: "role" must be "user" or "assistant"`);
  }
  if (typeof text !== "string") {
    throw new UsageError(`${where}: "text" must be a string`);
  }
  if (
    role === "assistant" &&
    text === "" &&
    !(Array.isArray(toolCalls) && toolCalls.length > 0)
  ) {
    throw new UsageError(
      `${where}: an assistant message needs text or tool calls`,
    );
  }
  if (toolCalls === undefined) return { role, text };
  if (role === "user") {
    throw new UsageError(`${where}: a user message has no "toolCalls"`);
  }
  return { role, text, toolCalls: readCalls(toolCalls, where) };
}

/**
 * Reads the value of a `history.json`: the messages of a conversation that already happened.
 * @param value - The parsed file.
 * @param where - Names the file, for error messages.
 * @returns The messages, in order.
 * @throws {UsageError} When the value is not a non-empty list of messages, or a message is not valid and strict.
 */
export function readHistory(value: unknown, where: string): History {
  if (!Array.isArray(value) || value.length === 0) {
    throw new UsageError(`${where}: must be a non-empty list of messages`);
  }
  return value.map((raw: unknown, index) =>
    readMessage(raw, `${where} [${String(index)}]`),
  );
}

/**
 * Checks the directory of a prior session.
 * @param cwd - The `cwd` value.
 * @param where - Names the file and the session.
 * @throws {UsageError} When it is no string, is empty or absolute, or leaves the workspace: it is a path below the
 *   workspace's real path, and an absolute path would be written into a file that the agent can read.
 */
function requireInsideCwd(cwd: unknown, where: string): asserts cwd is string {
  if (typeof cwd !== "string" || cwd === "") {
    throw new UsageError(`${where}: "cwd" must be a non-empty string`);
  }
  const resolved = path.posix.normalize(cwd);
  if (path.isAbsolute(cwd) || resolved === ".." || resolved.startsWith("../")) {
    throw new UsageError(
      `${where}: "cwd" must be a path below the workspace, not an absolute path or one that leaves it`,
    );
  }
}

/**
 * Reads one prior session.
 * @param raw - The value of the list's entry.
 * @param where - Names the file and the entry.
 * @returns The session, with `cwd` only when it has one.
 * @throws {UsageError} For an unknown key, an id that is no safe file name, a start that is no date, a `cwd` that is
 *   no string, or messages that are not valid.
 */
function readSession(raw: unknown, where: string): PriorSession {
  const session = objectAt(raw, where);
  exactKeys(session, SESSION_KEYS, where);
  const { id, startedAt, cwd, messages } = session;
  if (typeof id !== "string" || !SESSION_ID.test(id)) {
    throw new UsageError(
      `${where}: "id" must be letters, digits, ".", "_" and "-" and may not start with "."`,
    );
  }
  if (typeof startedAt !== "string" || Number.isNaN(Date.parse(startedAt))) {
    throw new UsageError(`${where}: "startedAt" must be a date`);
  }
  if (cwd !== undefined) requireInsideCwd(cwd, where);
  return {
    id,
    startedAt,
    ...(cwd === undefined ? {} : { cwd }),
    messages: readHistory(messages, `${where} messages`),
  };
}

/**
 * Reads the value of a `sessions/sessions.json`: earlier sessions for the harness's prior-session store.
 * @param value - The parsed file.
 * @param where - Names the file, for error messages.
 * @returns The sessions, in order.
 * @throws {UsageError} When the value is not a non-empty list of sessions, a session is not valid and strict, or two
 *   sessions share an id.
 */
export function readSessions(value: unknown, where: string): PriorSession[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new UsageError(`${where}: must be a non-empty list of sessions`);
  }
  const sessions = value.map((raw: unknown, index) =>
    readSession(raw, `${where} [${String(index)}]`),
  );
  const ids = sessions.map(({ id }) => id);
  const twice = ids.find((id, index) => ids.indexOf(id) !== index);
  if (twice !== undefined) {
    throw new UsageError(`${where}: two sessions have the id "${twice}"`);
  }
  return sessions;
}
