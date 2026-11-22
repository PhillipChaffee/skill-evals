import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  History,
  HistoryMessage,
  PriorSession,
  Seeding,
} from "../history-types.js";

/**
 * What the format below was read from: the strings of `/opt/claude-code/bin/claude` 2.1.330, with `grep -a`. No
 * model ran, so no real Claude Code has been shown to accept a session written this way (`docs/design/`).
 */
const FORMAT_FROM = "2.1.330";

// The binary's own limit for the name of a project directory, and the base of the hash that it adds past the limit.
const NAME_LIMIT = 200;
const HASH_BASE = 36;
const HASH_MULTIPLIER = 31;
// How many characters of a hash make a message id or a call id.
const ID_LENGTH = 24;
const MS_PER_SECOND = 1000;
const OWNER_ONLY = 0o600;
// A history has no times, so its messages are a second apart from a fixed start.
const HISTORY_START = "2026-01-01T00:00:00.000Z";
// 8, 4, 1 (dropped), 3, 1 (dropped), 3 and 12 characters of a hash, which make a version 4 UUID with variant 8.
const UUID_LENGTH = 36;
const UUID_SHAPE = /^(.{8})(.{4}).(.{3}).(.{3})(.{12})/;

/**
 * The hash the binary adds to a long project name: Java's string hash, `(h << 5) - h + code`, as a 32-bit integer.
 * @param text - The path.
 * @returns The signed 32-bit hash.
 */
function stringHash(text: string): number {
  let hash = 0;
  for (let at = 0; at < text.length; at += 1) {
    hash = (Math.imul(hash, HASH_MULTIPLIER) + text.charCodeAt(at)) | 0;
  }
  return hash;
}

/**
 * Names the directory that Claude Code keeps the sessions of a working directory in, under `projects/`.
 * @param cwd - The working directory.
 * @returns Every character that is not a letter or a digit replaced by `-`; past 200 characters, the first 200, a `-`
 *   and the absolute value of the string hash in base 36, as the binary does.
 */
export function projectName(cwd: string): string {
  const name = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return name.length <= NAME_LIMIT
    ? name
    : `${name.slice(0, NAME_LIMIT)}-${Math.abs(stringHash(cwd)).toString(HASH_BASE)}`;
}

/**
 * Makes a UUID that depends only on a text, so that planting the same history twice writes the same file.
 * @param text - What the UUID stands for.
 * @returns A UUID-shaped id with the version and variant bits of a random one.
 */
function uuidOf(text: string): string {
  const hex = createHash("sha256").update(text).digest("hex");
  return hex.replace(UUID_SHAPE, "$1-$2-4$3-8$4-$5").slice(0, UUID_LENGTH);
}

/**
 * Makes an id for a message or a call.
 * @param prefix - `msg` or `toolu`.
 * @param text - What the id stands for.
 * @returns The prefix, `_`, and a stretch of the hash of the text.
 */
const idOf = (prefix: string, text: string): string =>
  `${prefix}_${uuidOf(text).replaceAll("-", "").slice(0, ID_LENGTH)}`;

/** What every line of one session shares. */
interface Stamp {
  sessionId: string;
  cwd: string;
  /** The time of the first line, in milliseconds. */
  start: number;
}

/** The lines written so far, and the one that the next line follows. */
interface Chain {
  lines: string[];
  parent: string | null;
}

/**
 * Appends one line to a session, in the format of Claude Code's own session files.
 * @param chain - The lines so far; the new line follows the last one.
 * @param stamp - The session's id, directory and start.
 * @param line - The type of the line and its message.
 * @param line.type - `user` or `assistant`.
 * @param line.message - The API message.
 */
function push(
  chain: Chain,
  stamp: Stamp,
  line: { type: "user" | "assistant"; message: object },
): void {
  const count = chain.lines.length + 1;
  const uuid = uuidOf(`${stamp.sessionId}:${String(count)}`);
  chain.lines.push(
    JSON.stringify({
      parentUuid: chain.parent,
      isSidechain: false,
      userType: "external",
      cwd: stamp.cwd,
      sessionId: stamp.sessionId,
      version: FORMAT_FROM,
      ...line,
      uuid,
      timestamp: new Date(stamp.start + count * MS_PER_SECOND).toISOString(),
    }),
  );
  chain.parent = uuid;
}

/**
 * Appends an assistant message: one line with its text and `tool_use` blocks, and, when it made calls, a `user` line of
 * `tool_result` blocks. A call without an output gets an empty result, because the API refuses a call with none.
 * @param chain - The lines so far.
 * @param stamp - The session's id, directory and start.
 * @param message - The message, and its place in the history from 0.
 * @param message.at - The message's place in the history.
 * @param message.message - The assistant message to write.
 * @throws {Error} For a message with neither text nor calls, which the API would refuse on resume.
 */
function pushAssistant(
  chain: Chain,
  stamp: Stamp,
  { at, message }: { at: number; message: HistoryMessage },
): void {
  const calls = (message.toolCalls ?? []).map((call, order) => ({
    call,
    id: idOf("toolu", `${stamp.sessionId}:${String(at)}:${String(order)}`),
  }));
  if (message.text === "" && calls.length === 0) {
    throw new Error(`message ${String(at + 1)} has no text and no calls`);
  }
  push(chain, stamp, {
    type: "assistant",
    message: {
      id: idOf("msg", `${stamp.sessionId}:${String(at)}`),
      type: "message",
      role: "assistant",
      model: "<synthetic>",
      content: [
        ...(message.text === "" ? [] : [{ type: "text", text: message.text }]),
        ...calls.map(({ call, id }) => ({
          type: "tool_use",
          id,
          name: call.name,
          input: call.input,
        })),
      ],
      stop_reason: calls.length === 0 ? "end_turn" : "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  if (calls.length === 0) return;
  push(chain, stamp, {
    type: "user",
    message: {
      role: "user",
      content: calls.map(({ call, id }) => ({
        type: "tool_result",
        tool_use_id: id,
        content: call.output ?? "",
      })),
    },
  });
}

/**
 * Writes the lines of one session, in the format of Claude Code's own session files: one JSON object per line, each
 * with `uuid`, `parentUuid` (the line before), `type`, `message`, `timestamp`, `sessionId` and `cwd`.
 * @param history - The messages.
 * @param stamp - The session's id, directory and start.
 * @returns The lines, without newlines.
 * @throws {Error} For an assistant message with neither text nor calls, which the API would refuse on resume.
 */
function sessionLines(history: History, stamp: Stamp): string[] {
  const chain: Chain = { lines: [], parent: null };
  for (const [at, message] of history.entries()) {
    if (message.role === "assistant") {
      pushAssistant(chain, stamp, { at, message });
    } else {
      push(chain, stamp, {
        type: "user",
        message: { role: "user", content: message.text },
      });
    }
  }
  return chain.lines;
}

/**
 * Writes one session file under the project directory of a working directory.
 * @param configDir - Claude Code's config directory, the run's `CLAUDE_CONFIG_DIR`.
 * @param stamp - The session's id, directory and start.
 * @param history - The messages.
 */
function writeSession(configDir: string, stamp: Stamp, history: History): void {
  const dir = path.join(configDir, "projects", projectName(stamp.cwd));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${stamp.sessionId}.jsonl`),
    `${sessionLines(history, stamp).join("\n")}\n`,
    { mode: OWNER_ONLY },
  );
}

/**
 * Writes a history as Claude Code's active session for the run's workspace: `<home>/.claude/projects/<encoded
 * cwd>/<id>.jsonl`. The first turn continues it with `--resume <id>`. The id depends only on the history.
 * @param history - The messages of `history.json`.
 * @param where - The run's home and workspace.
 * @returns The id of the session.
 */
export function installClaudeHistory(
  history: History,
  where: Seeding,
): { session: string } {
  // The binary names the directory after the real path of its working directory.
  const cwd = fs.realpathSync(where.workspace);
  const session = uuidOf(JSON.stringify(history));
  writeSession(
    path.join(where.home, ".claude"),
    { sessionId: session, cwd, start: Date.parse(HISTORY_START) },
    history,
  );
  return { session };
}

/**
 * Writes earlier sessions into Claude Code's project directories, where its own session list finds them.
 * @param sessions - The sessions of `sessions/sessions.json`.
 * @param where - The run's home and workspace; a session without a `cwd` is the workspace's.
 */
export function installClaudeSessions(
  sessions: PriorSession[],
  where: Seeding,
): void {
  const workspace = fs.realpathSync(where.workspace);
  for (const session of sessions) {
    writeSession(
      path.join(where.home, ".claude"),
      {
        sessionId: session.id,
        cwd: session.cwd ?? workspace,
        start: Date.parse(session.startedAt),
      },
      session.messages,
    );
  }
}
