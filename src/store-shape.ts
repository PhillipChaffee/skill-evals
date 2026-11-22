/** One field of a run record that the report, the command line or a resume reads, and what it may hold. */
type Shape = (value: unknown) => boolean;

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text: Shape = (value) => typeof value === "string";
const count: Shape = (value) => typeof value === "number";
const flag: Shape = (value) => typeof value === "boolean";
const list: Shape = (value) => Array.isArray(value);
const orNull =
  (inner: Shape): Shape =>
  (value) =>
    value === null || inner(value);

/**
 * The fields that every line of `results.jsonl` must have. A line that lacks one, or has the wrong kind of value, is
 * not a run record: reading it would fail where the report, the progress line or a resume uses the field.
 */
export const LINE_FIELDS: Record<string, Shape> = {
  key: text,
  attempt: count,
  harness: text,
  caseId: text,
  subject: text,
  rep: count,
  ok: flag,
  error: orNull(text),
  finalText: text,
  subjectLoaded: orNull(flag),
  isolated: flag,
  unexpected: list,
  reportMissing: flag,
  judgeProblem: orNull(text),
  checks: (value) =>
    Array.isArray(value) &&
    value.every(
      (check) =>
        isObject(check) &&
        (check["score"] === null || typeof check["score"] === "number"),
    ),
  score: orNull(count),
  durationMs: count,
  tokens: orNull(isObject),
  costUsd: orNull(count),
  judge: orNull(isObject),
  decision: orNull(isObject),
};

/**
 * Tells whether a parsed line has the shape of a stored run.
 * @param value - What `JSON.parse` returned.
 * @returns True when it is an object with every field of `LINE_FIELDS`, each of its kind.
 */
export const isStoredRun = (value: unknown): boolean =>
  isObject(value) &&
  Object.entries(LINE_FIELDS).every(([name, shape]) => shape(value[name]));
