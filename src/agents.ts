import type { AgentRef } from "./harnesses/shared.js";
import { UsageError } from "./scope.js";

/** Who a check looks at: the main thread, any subagent, or the agents of one type. */
export type By = "main" | "subagent" | { agent: string };

/** The main thread, which every event belongs to unless the harness attributes it to a subagent. */
export const MAIN_AGENT: AgentRef = {
  id: "main",
  type: "main",
  parent: null,
  depth: 0,
};

/**
 * Drops the plugin prefix of an agent name, the way skill names lose theirs.
 * @param name - An agent as a dispatch names it: `name`, `plugin:name` or `plugin:name:name`.
 * @returns The part after the last colon.
 */
export const normalizeAgent = (name: string): string =>
  name.slice(name.lastIndexOf(":") + 1);

/**
 * Tells whether an agent is one a `by` names.
 * @param by - What the check looks at; absent means every agent.
 * @param agent - The agent that made a call or wrote an event; absent means the main thread, as in a 0.0.1 record.
 * @returns True for no `by`; for `"main"` when the depth is 0; for `"subagent"` when it is above 0; for `{ agent }`
 *   when the agent's type equals the normalized name.
 */
export function fitsBy(
  by: By | undefined,
  agent: AgentRef | undefined,
): boolean {
  if (by === undefined) return true;
  const { depth, type } = agent ?? MAIN_AGENT;
  if (by === "main") return depth === 0;
  if (by === "subagent") return depth > 0;
  return type === normalizeAgent(by.agent);
}

/**
 * Writes a `by` the way a reason names it.
 * @param by - A `by`.
 * @returns `main`, `subagent` or `agent <name>`.
 */
export const describeBy = (by: By): string =>
  typeof by === "string" ? by : `agent ${by.agent}`;

const EXPECTED =
  'one of "main", "subagent", or an object { "agent": "<name>" } with a non-empty name';

/**
 * Reads a `by`.
 * @param value - The parsed value.
 * @param where - Names the file, the check and the key in an error message.
 * @returns The value, as a `By`.
 * @throws {UsageError} For any value but "main", "subagent", or an object whose only key is a string `agent` that
 *   normalizes to a name; `{ agent: "main" }` is an error that says to use `by: "main"`. `{ agent: "unknown" }` is
 *   allowed: it names the orphan child events whose dispatch the stream never showed.
 */
export function parseBy(value: unknown, where: string): By {
  if (value === "main" || value === "subagent") return value;
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).join() === "agent"
  ) {
    const { agent } = value as { agent: unknown };
    if (typeof agent === "string" && normalizeAgent(agent) === "main") {
      throw new UsageError(`${where}: use by: "main" for the main thread`);
    }
    if (typeof agent === "string" && normalizeAgent(agent) !== "") {
      return { agent };
    }
  }
  throw new UsageError(`${where}: "by" must be ${EXPECTED}`);
}
