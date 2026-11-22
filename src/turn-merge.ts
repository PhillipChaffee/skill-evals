import type {
  Loaded,
  Parsed,
  Tokens,
  TranscriptEvent,
} from "./harnesses/shared.js";
import { NOT_REPORTED, sumTokens, withIndexes } from "./harnesses/shared.js";
import { callsOf } from "./transcript.js";

/**
 * Makes the parse of a turn that sent nothing: a turn that was skipped, or an event the runner carries out itself.
 * @param events - The turn's events, if any.
 * @returns A parse with no text, no calls, no tokens and no cost.
 */
export const emptyParse = (events: TranscriptEvent[] = []): Parsed => ({
  finalText: "",
  toolCalls: [],
  transcript: events,
  sessionId: null,
  tokens: null,
  costUsd: null,
  loaded: NOT_REPORTED,
  error: null,
});

/**
 * Adds up the usage of each agent over several turns.
 * @param parts - The `agentTokens` of each turn.
 * @returns Agent id to its total; null when no turn states any.
 */
function sumAgents(
  parts: (Record<string, Tokens> | null | undefined)[],
): Record<string, Tokens> | null {
  const stated = parts.filter((part) => part != null);
  if (stated.length === 0) return null;
  const totals: Record<string, Tokens> = {};
  for (const part of stated) {
    for (const [agent, tokens] of Object.entries(part)) {
      const total = (totals[agent] ??= { input: 0, output: 0 });
      total.input += tokens.input;
      total.output += tokens.output;
    }
  }
  return totals;
}

/**
 * Sums the cost of the turns that ran a process.
 * @param costs - Each such turn's cost; null for one that stated none.
 * @returns The sum; null when any turn stated none, since a partial sum would read as the whole cost.
 */
const sumCosts = (costs: (number | null)[]): number | null =>
  costs.length > 0 && costs.every((cost) => cost !== null)
    ? costs.reduce((total, cost) => total + cost, 0)
    : null;

/**
 * Joins what several processes reported of one kind of thing.
 * @param lists - Each process's list; null where it does not report that kind.
 * @returns Every name that any process reported, first seen first, without repeats; null when none reports the kind.
 */
function union<T>(lists: (T[] | null | undefined)[]): T[] | null {
  const stated = lists.filter((list) => list != null);
  return stated.length === 0 ? null : [...new Set(stated.flat())];
}

/**
 * Joins the startup reports of the processes of a run, so that something that only a later turn's process loaded is
 * in the record too.
 * @param reports - What each process reported as loaded, in order.
 * @returns For each kind, the union over the processes; a kind that no process reports stays null. A plugin is kept
 *   once, by its path.
 */
export function unionLoaded(reports: Loaded[]): Loaded {
  const named = (key: "rawSkills" | "plugins"): boolean =>
    reports.some((one) => key in one);
  const plugins = union(reports.map((one) => one.plugins));
  return {
    paths: union(reports.map((one) => one.paths)),
    skills: union(reports.map((one) => one.skills)),
    agents: union(reports.map((one) => one.agents)),
    rules: union(reports.map((one) => one.rules)),
    hooks: union(reports.map((one) => one.hooks)),
    mcpServers: union(reports.map((one) => one.mcpServers)),
    // An adapter that does not name these keys leaves them out; one that names them null keeps null.
    ...(named("rawSkills")
      ? { rawSkills: union(reports.map((one) => one.rawSkills)) }
      : {}),
    ...(named("plugins")
      ? {
          plugins:
            plugins === null
              ? null
              : [...new Map(plugins.map((one) => [one.path, one])).values()],
        }
      : {}),
  };
}

/**
 * Renumbers the events of each turn into one run: every event gets the number of its turn as `userTurn`, from 1; the
 * positions of events run on without a break; and the assistant turns are counted on from the turns before.
 * @param parts - The parse of each turn, in order.
 * @returns The events of the run.
 */
function eventsOf(parts: Parsed[]): TranscriptEvent[] {
  let position = 0;
  let before = 0;
  return parts.flatMap((part, index) => {
    const turns = part.transcript.flatMap((event) => event.turn ?? []);
    const offset = before;
    before += turns.reduce((most, turn) => Math.max(most, turn), 0);
    return part.transcript.map((event): TranscriptEvent => ({
      ...event,
      index: position++,
      userTurn: index + 1,
      turn: event.turn === null ? null : event.turn + offset,
    }));
  });
}

/**
 * Puts the parses of the turns of a run into one.
 * @param parts - The parse of each turn, in order, with an empty parse for a turn that sent nothing.
 * @param ran - Which of them came from a harness process.
 * @returns One parse: the events of every turn with their `userTurn`, tool calls renumbered across turns and each
 *   marked with its `userTurn`, the final text of the last turn that ran a process, the tokens and the cost summed
 *   (the cost is null when any process turn stated none), `loaded` the union over every process (`unionLoaded`), and the session id of the
 *   last process. `error` is the first error of a turn.
 */
export function mergeTurns(parts: Parsed[], ran: boolean[]): Parsed {
  const processes = parts.filter((_, index) => ran[index]);
  const transcript = eventsOf(parts);
  const callEvents = transcript.filter((event) => event.type === "tool_call");
  const toolCalls = withIndexes(
    callsOf(transcript).map((call, position) => ({
      ...call,
      userTurn: callEvents[position]?.userTurn ?? 0,
    })),
  );
  const last = processes.at(-1);
  return {
    finalText: last?.finalText ?? "",
    toolCalls,
    transcript,
    sessionId: last?.sessionId ?? null,
    tokens: sumTokens(processes.flatMap((part) => part.tokens ?? [])),
    agentTokens: sumAgents(processes.map((part) => part.agentTokens)),
    costUsd: sumCosts(processes.map((part) => part.costUsd)),
    loaded: unionLoaded(processes.map((part) => part.loaded)),
    askedUser: last?.askedUser ?? null,
    error: parts.find((part) => part.error !== null)?.error ?? null,
    ...(last?.hitMaxTurns === undefined
      ? {}
      : { hitMaxTurns: last.hitMaxTurns }),
    ...(last?.unfinished === undefined ? {} : { unfinished: last.unfinished }),
  };
}
