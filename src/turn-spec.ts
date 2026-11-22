import type { Check } from "./checks/index.js";
import { isDecision, isJudged, readCheck } from "./checks/index.js";
import { extensionsOf } from "./checks/extensions.js";
import type { FieldDef, Mode } from "./checks/fields.js";
import { readField } from "./checks/fields.js";
import type { Invoke, LifecycleEvent } from "./harnesses/shared.js";
import { UsageError } from "./scope.js";
import { promptFileOf } from "./turn-files.js";

/** The lifecycle events a turn can be, in the order the docs list them. */
export const LIFECYCLE_EVENTS: readonly LifecycleEvent[] = [
  "compact",
  "clear",
  "resume",
];

/** What a turn does. */
type TurnStep =
  | {
      /** The user's message: the text of the prompt file. */
      prompt: string;
      /** The prompt file as the case file names it, relative to the case's directory. */
      file: string;
    }
  | { invoke: Invoke }
  | {
      /**
       * A message that is sent only when the previous sent turn ended awaiting the user and one of its questions fits
       * `whenAsked`; otherwise the turn is skipped as "not asked".
       */
      reply: {
        /** A regular expression for the question text (see `questionText`). */
        whenAsked: string;
        /** The text of the prompt file. */
        prompt: string;
        /** The prompt file as the case file names it, relative to the case's directory. */
        file: string;
      };
    }
  | { event: LifecycleEvent };

/** One turn of a case: what the user does, and the checks that look at that turn only. Each check carries its `turn`. */
export type Turn = TurnStep & { checks: Check[] };

// The keys of an object in the `turns` list. Any other key is a load error, unless it starts with `x-`.
export const TURN_KEYS: Record<string, FieldDef> = {
  prompt: {
    type: "text",
    meaning:
      "A message from the user: a file of the case's directory, such as `turn-2.md`, whose text is sent. It stays inside the case and outside `grader/`. Give exactly one of `prompt`, `invoke`, `reply` and `event`.",
  },
  invoke: {
    type: "object",
    meaning:
      'A user invocation of a skill: `{ "skill": "<name>", "args": "<text>" }`, sent in the harness\'s own user syntax (`/skill args` in Claude Code). A harness that has no confirmed syntax lacks `userInvoke`, and the case is not applicable there.',
  },
  reply: {
    type: "object",
    meaning:
      'A conditional reply to the agent\'s question: `{ "whenAsked": "<regex>", "prompt": "<file>" }`. The prompt file is sent only when the previous sent turn ended awaiting the user (see `ended_awaiting_user`) and one of its questions matches `whenAsked`; otherwise the turn is skipped as "not asked", and its checks are not scored. It needs the harness capabilities `multiTurn` and `askUser`, and may not be the first turn. Give exactly one of `prompt`, `invoke`, `reply` and `event`.',
  },
  event: {
    type: "enum",
    values: LIFECYCLE_EVENTS,
    meaning:
      "A lifecycle event between messages: `compact`, `clear` or `resume`. It needs the harness capability of the same name. It may not be the first turn.",
  },
  checks: {
    type: "object",
    meaning:
      "A non-empty list of checks that look at this turn only: its slice of the transcript, its tool calls and its final text, and, for `file_changed`, `file_unchanged` and `files_changed_only`, the paths this turn changed. Every other file check and every `command` check sees the final workspace. A `judge` or `decision` check belongs at case level.",
  },
};

const REPLY_KEYS: Record<string, FieldDef> = {
  whenAsked: {
    type: "regex",
    meaning:
      "A regular expression for the question text, case-sensitive. Claude Code's question is the `questions[].question` texts joined with newlines.",
  },
  prompt: {
    type: "text",
    meaning:
      "The reply: a file of the case's directory, whose text is sent. It stays inside the case and outside `grader/`.",
  },
};

const INVOKE_KEYS: Record<string, FieldDef> = {
  skill: { type: "text", meaning: "The skill's name." },
  args: { type: "text", meaning: "What the user types after the name." },
};

// The checks that read what one turn changed: they take no `root: "home"`, because the home is hashed once per run.
const TURN_FILE_CHECKS = new Set([
  "file_changed",
  "file_unchanged",
  "files_changed_only",
]);

/** Where a turn is, for its messages and its prompt file. */
interface Where {
  /** The case file. */
  file: string;
  /** The case's directory, which a prompt file is relative to. */
  dir: string;
  mode: Mode;
}

/**
 * Reads the `invoke` of a turn.
 * @param raw - The value as the case file holds it, already known to be an object.
 * @param where - Names the case file and the turn.
 * @param mode - Whether an unknown key is an error or is dropped with a warning.
 * @returns The skill and its arguments.
 * @throws {UsageError} For a missing skill, an unknown key, or a value of the wrong type.
 */
function readInvoke(raw: unknown, where: string, mode: Mode): Invoke {
  const siblings = raw as Record<string, unknown>;
  const at = { where: `${where} invoke`, owner: "an invoke", siblings };
  extensionsOf(Object.keys(INVOKE_KEYS), at, mode);
  const skill = readField(INVOKE_KEYS, "skill", at) as string;
  return siblings["args"] === undefined
    ? { skill }
    : { skill, args: readField(INVOKE_KEYS, "args", at) as string };
}

/**
 * Reads the `reply` of a turn.
 * @param raw - The value as the case file holds it, already known to be an object.
 * @param place - Names the case file and the turn, and the case's directory and loading mode.
 * @param place.name - Names the case file and the turn.
 * @param place.where - The case file, its directory and the loading mode.
 * @returns The condition, and the text and file name of the reply.
 * @throws {UsageError} For a missing key, an unknown key, a bad regular expression or a bad prompt file.
 */
function readReply(
  raw: unknown,
  place: { name: string; where: Where },
): Extract<TurnStep, { reply: unknown }>["reply"] {
  const siblings = raw as Record<string, unknown>;
  const at = { where: `${place.name} reply`, owner: "a reply", siblings };
  extensionsOf(Object.keys(REPLY_KEYS), at, place.where.mode);
  const whenAsked = readField(REPLY_KEYS, "whenAsked", at) as string;
  const file = readField(REPLY_KEYS, "prompt", at) as string;
  return {
    whenAsked,
    prompt: promptFileOf(place.where.dir, file, place.name),
    file,
  };
}

/**
 * Reads the checks of a turn.
 * @param raw - The turn's `checks`, or undefined.
 * @param at - The turn's place, and its number counted from 1.
 * @param at.where - Names the case file and the turn.
 * @param at.mode - Whether an unknown key is an error or is dropped with a warning.
 * @param at.turn - The turn's number, set on each check so that a result can say which turn it is for.
 * @returns The checks, each with its `turn`; none for a turn without any.
 * @throws {UsageError} For an empty list, a check that is not valid, a `judge` or `decision` check, or a file-change
 *   check on the home.
 */
function readTurnChecks(
  raw: unknown,
  at: { where: string; mode: Mode; turn: number },
): Check[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new UsageError(`${at.where}: "checks" must be a non-empty array`);
  }
  return raw.map((one: unknown, index) => {
    const check = readCheck(
      one,
      `${at.where} checks[${String(index)}]`,
      at.mode,
    );
    const here = `${at.where} checks[${String(index)}]`;
    if (isJudged(check) || isDecision(check)) {
      throw new UsageError(
        `${here}: a ${check.type} check reads the whole run; put it in the case's "checks"`,
      );
    }
    if (TURN_FILE_CHECKS.has(check.type) && check.root === "home") {
      throw new UsageError(
        `${here}: ${check.type} on a turn reads the workspace changes of that turn; "root": "home" belongs in the case's "checks"`,
      );
    }
    return { ...check, turn: at.turn };
  });
}

/**
 * Reads one turn.
 * @param raw - The turn as the case file holds it.
 * @param place - The turn's index, from 0, and where the case is.
 * @param place.index - The turn's position in the `turns` list.
 * @param place.where - The case file, its directory and the loading mode.
 * @returns The turn, with its prompt file read and its checks loaded.
 * @throws {UsageError} For a value that is no object, an unknown key, none or more than one of `prompt`, `invoke` and
 *   `event`, a bad prompt file, or a bad check.
 */
function readTurn(
  raw: Record<string, unknown>,
  place: { index: number; where: Where },
): Turn {
  const { index, where } = place;
  const name = `${where.file} turns[${String(index)}]`;
  const at = { where: name, owner: "a turn", siblings: raw };
  extensionsOf(Object.keys(TURN_KEYS), at, where.mode);
  const given = ["prompt", "invoke", "reply", "event"].filter(
    (key) => raw[key] !== undefined,
  );
  if (given.length !== 1) {
    throw new UsageError(
      `${name}: a turn needs exactly one of "prompt", "invoke", "reply" and "event"`,
    );
  }
  const checks = readTurnChecks(raw["checks"], {
    where: name,
    mode: where.mode,
    turn: index + 1,
  });
  if (raw["prompt"] !== undefined) {
    const file = readField(TURN_KEYS, "prompt", at) as string;
    return { prompt: promptFileOf(where.dir, file, name), file, checks };
  }
  if (raw["invoke"] !== undefined) {
    const invoke = readField(TURN_KEYS, "invoke", at);
    return { invoke: readInvoke(invoke, name, where.mode), checks };
  }
  if (raw["reply"] !== undefined) {
    const reply = readField(TURN_KEYS, "reply", at);
    return { reply: readReply(reply, { name, where }), checks };
  }
  const event = readField(TURN_KEYS, "event", at) as LifecycleEvent;
  if (event !== "compact" && checks.length > 0) {
    throw new UsageError(
      `${name}: a ${event} turn sends nothing, so it has no checks; put them on the turn before or after it`,
    );
  }
  return { event, checks };
}

/**
 * Reads the `turns` of a case or of a variant.
 * @param list - The value of the key, already known to be a non-empty list of objects.
 * @param where - The case file, the case's directory and the loading mode.
 * @returns The turns, in order.
 * @throws {UsageError} For a bad turn, or when the first turn is an event or a reply: both act on a session that exists.
 */
export function readTurns(
  list: Record<string, unknown>[],
  where: Where,
): Turn[] {
  const turns = list.map((raw, index) => readTurn(raw, { index, where }));
  if (turns[0] !== undefined && ("event" in turns[0] || "reply" in turns[0])) {
    throw new UsageError(
      `${where.file} turns[0]: the first turn must be a "prompt" or an "invoke"; an event or a reply acts on a session that exists`,
    );
  }
  return turns;
}

/**
 * Says what a turn is, in the words of a report.
 * @param turn - The turn to describe.
 * @returns The prompt text, `reply when asked /<regex>/: <text>`, `invoke <skill> <args>`, or `event <name>`.
 */
export function describeTurn(turn: Turn): string {
  if ("prompt" in turn) return turn.prompt;
  if ("reply" in turn) {
    return `reply when asked /${turn.reply.whenAsked}/: ${turn.reply.prompt}`;
  }
  if ("invoke" in turn) {
    return ["invoke", turn.invoke.skill, turn.invoke.args]
      .filter(Boolean)
      .join(" ");
  }
  return `event ${turn.event}`;
}

/**
 * Writes the task of a case with turns as one text, for what reads a case's `prompt`: the judge, and the hash of
 * what the agent sees.
 * @param turns - The case's turns.
 * @returns Each turn after a heading with its number, separated by blank lines.
 */
export const taskOf = (turns: Turn[]): string =>
  turns
    .map((turn, index) => `Turn ${String(index + 1)}: ${describeTurn(turn)}`)
    .join("\n\n");

/**
 * Takes what the agent sees of a turn: its text, its invocation or its event, without its checks or file name.
 * @param turn - Any turn.
 * @returns The part that decides what the agent is given.
 */
export const stepOf = (turn: Turn): Record<string, unknown> => {
  if ("prompt" in turn) return { prompt: turn.prompt };
  if ("reply" in turn) {
    return {
      reply: { whenAsked: turn.reply.whenAsked, prompt: turn.reply.prompt },
    };
  }
  return "invoke" in turn ? { invoke: turn.invoke } : { event: turn.event };
};
