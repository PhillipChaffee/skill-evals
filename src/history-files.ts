import fs from "node:fs";
import path from "node:path";
import { readHistory, readSessions } from "./history-spec.js";
import type { History, PriorSession } from "./history-types.js";
import { requireLinksInside } from "./isolate.js";
import { UsageError, messageOf } from "./scope.js";

const HISTORY_FILE = "history.json";
const SESSIONS_DIR = "sessions";
const SESSIONS_FILE = "sessions.json";

/**
 * Tells whether a path is strictly inside a directory.
 * @param root - The directory.
 * @param target - The path.
 * @returns True when `target` is below `root` and is not `root` itself.
 */
function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/**
 * Tells whether a path exists, a link to nothing included.
 * @param file - The path.
 * @returns True when something, even a dangling link, is there.
 */
function present(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads a JSON file of the case, under the rules of the case's other files: a link must lead to a file inside the case,
 * and the file may not be in `grader/`, whose files the agent must never see.
 * @param dir - The case's directory.
 * @param relative - The file's path below it.
 * @returns The parsed value; undefined when there is no such file.
 * @throws {UsageError} When the file is no regular file, leads out of the case or into `grader/`, or is not JSON.
 */
function jsonOf(dir: string, relative: string): unknown {
  const file = path.join(dir, relative);
  const fail = (problem: string): UsageError =>
    new UsageError(`${file}: ${problem}`);
  if (!present(file)) return undefined;
  let real: string;
  try {
    real = fs.realpathSync(file);
  } catch {
    throw fail("is a link to nothing");
  }
  const root = fs.realpathSync(dir);
  if (!inside(root, real)) throw fail("must stay inside the case");
  if (path.relative(root, real).split(path.sep)[0] === "grader") {
    throw fail("is in grader/, whose files the agent must not see");
  }
  if (!fs.statSync(real).isFile()) throw fail("is not a file");
  try {
    return JSON.parse(fs.readFileSync(real, "utf8")) as unknown;
  } catch (error) {
    throw fail(messageOf(error));
  }
}

/**
 * Reads a case's `history.json`.
 * @param dir - The case's directory.
 * @returns The messages; undefined when the case has none.
 * @throws {UsageError} When the file leaves the case, is not JSON, or is not a strict list of messages.
 */
function historyOf(dir: string): History | undefined {
  const value = jsonOf(dir, HISTORY_FILE);
  return value === undefined
    ? undefined
    : readHistory(value, path.join(dir, HISTORY_FILE));
}

/**
 * Reads a case's `sessions/sessions.json`.
 * @param dir - The case's directory.
 * @returns The sessions; undefined when the case has no `sessions/` directory.
 * @throws {UsageError} When `sessions` is no directory, a link in it leaves it, `sessions.json` is missing, leaves the
 *   case, is not JSON, or is not a strict list of sessions.
 */
function sessionsOf(dir: string): PriorSession[] | undefined {
  const folder = path.join(dir, SESSIONS_DIR);
  if (!present(folder)) return undefined;
  let real: string;
  try {
    real = fs.realpathSync(folder);
  } catch {
    throw new UsageError(`${folder}: is a link to nothing`);
  }
  if (!inside(fs.realpathSync(dir), real)) {
    throw new UsageError(`${folder}: must stay inside the case`);
  }
  if (!fs.statSync(real).isDirectory()) {
    throw new UsageError(`${folder}: must be a directory`);
  }
  try {
    requireLinksInside(folder, "the sessions directory");
  } catch (error) {
    throw new UsageError(`${folder}: ${messageOf(error)}`);
  }
  const file = path.join(SESSIONS_DIR, SESSIONS_FILE);
  const value = jsonOf(dir, file);
  if (value === undefined) {
    throw new UsageError(`${folder}: needs ${SESSIONS_FILE}`);
  }
  return readSessions(value, path.join(dir, file));
}

/**
 * Reads the history and the prior sessions of a case directory.
 * @param dir - The case's directory.
 * @returns A key for each that the case has, and none for each it lacks, so that a case without them is unchanged.
 */
export function seedsOf(dir: string): {
  history?: History;
  sessions?: PriorSession[];
} {
  const history = historyOf(dir);
  const sessions = sessionsOf(dir);
  return {
    ...(history === undefined ? {} : { history }),
    ...(sessions === undefined ? {} : { sessions }),
  };
}
