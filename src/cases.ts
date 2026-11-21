import fs from "node:fs";
import path from "node:path";
import type { Check, Field, Spec } from "./checks.js";
import { CHECKS, REGEX_FIELDS, regex } from "./checks.js";
import { TOOL_KINDS } from "./harnesses/shared.js";
import { isUnitScore } from "./score.js";
import { UsageError, messageOf } from "./scope.js";

/** One prompt and what a good run of it does. */
export interface Case {
  id: string;
  prompt: string;
  checks: Check[];
  weight: number;
  minScore?: number | undefined;
  maxTurns?: number | undefined;
  timeoutSeconds: number;
  /** A directory whose content the agent starts with, or null for an empty workspace. */
  workspaceDir: string | null;
}

const DEFAULT_TIMEOUT_SECONDS = 600;

/** A value parsed from a case file, before it is known to be an object. */
type Raw = Partial<Record<string, unknown>> | null | undefined;

/**
 * Reads the weight of a case or a check.
 * @param raw - The parsed case or check.
 * @param where - Names the file and the check in an error message.
 * @returns The weight, 1 when none is given.
 * @throws {UsageError} When the weight is not a positive number.
 */
function weightOf(raw: Raw, where: string): number {
  const weight = raw?.["weight"] ?? 1;
  if (!(typeof weight === "number" && Number.isFinite(weight) && weight > 0)) {
    throw new UsageError(`${where}: weight must be a positive number`);
  }
  return weight;
}

/**
 * Reads the fields a check type takes.
 * @param raw - The parsed check.
 * @param spec - What its type requires and allows.
 * @param where - Names the file and the check in an error message.
 * @returns The fields that are set, in the order the type lists them.
 * @throws {UsageError} When a required field is missing, any field is not a non-empty string, or none of `oneOf` is set.
 */
function readFields(
  raw: NonNullable<Raw>,
  spec: Spec,
  where: string,
): Partial<Record<Field, string>> {
  const type = String(raw["type"]);
  const given: Partial<Record<Field, string>> = {};
  const optional = (spec.optional ?? []).filter(
    (field) => raw[field] !== undefined,
  );
  for (const field of [...spec.fields, ...optional]) {
    const value = raw[field];
    if (typeof value !== "string" || value === "") {
      throw new UsageError(`${where}: ${type} needs a string "${field}"`);
    }
    given[field] = value;
  }
  if (spec.oneOf && !spec.oneOf.some((field) => given[field] !== undefined)) {
    throw new UsageError(
      `${where}: ${type} needs at least one of ${spec.oneOf.map((field) => `"${field}"`).join(", ")}`,
    );
  }
  return given;
}

/**
 * Rejects field values that are strings but cannot be used.
 * @param given - The fields of one check.
 * @param where - Names the file and the check in an error message.
 * @throws {UsageError} For an unknown tool kind, an invalid regular expression, or a path that leaves the workspace.
 */
function requireUsable(
  given: Partial<Record<Field, string>>,
  where: string,
): void {
  const { kind, path: file, flags } = given;
  if (kind !== undefined && !(TOOL_KINDS as readonly string[]).includes(kind)) {
    throw new UsageError(
      `${where}: unknown tool kind "${kind}"; known: ${TOOL_KINDS.join(", ")}`,
    );
  }
  try {
    for (const field of REGEX_FIELDS) {
      const pattern = given[field];
      if (pattern !== undefined) regex(pattern, flags);
    }
  } catch (error) {
    throw new UsageError(`${where}: ${messageOf(error)}`);
  }
  if (
    file !== undefined &&
    (path.isAbsolute(file) || file.split(/[\\/]/).includes(".."))
  ) {
    throw new UsageError(
      `${where}: path must stay inside the workspace: ${file}`,
    );
  }
}

/**
 * Validates one check of a case file.
 * @param raw - The parsed check.
 * @param where - Names the file and the check in an error message.
 * @returns The check, holding only the fields its type takes.
 * @throws {UsageError} For an unknown type, a bad weight, or a field that is missing or unusable.
 */
function parseCheck(raw: Raw, where: string): Check {
  const type = raw?.["type"];
  const spec =
    typeof type === "string" && Object.hasOwn(CHECKS, type)
      ? CHECKS[type]
      : undefined;
  if (!raw || !spec) {
    throw new UsageError(
      `${where}: unknown check type ${JSON.stringify(type)}; known: ${Object.keys(CHECKS).join(", ")}`,
    );
  }
  const weight = weightOf(raw, where);
  const given = readFields(raw, spec, where);
  requireUsable(given, where);
  // The three steps above checked the type, the fields it requires, and the tool kind.
  return { type, weight, ...given } as Check;
}

/**
 * Reads an optional count from a case file.
 * @param value - The parsed value.
 * @param where - Names the file in an error message.
 * @param name - Names the key in an error message.
 * @returns The count, or undefined when the key is absent.
 * @throws {UsageError} When the value is not a positive integer.
 */
function positive(
  value: unknown,
  where: string,
  name: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!(typeof value === "number" && Number.isInteger(value) && value > 0)) {
    throw new UsageError(`${where}: ${name} must be a positive integer`);
  }
  return value;
}

/**
 * Loads one case from its directory.
 * @param dir - A directory with `prompt.md`, `case.json`, and an optional `workspace/`.
 * @returns The case, named after the directory.
 * @throws {UsageError} When a file is missing or does not hold a valid case.
 */
function loadCase(dir: string): Case {
  const id = path.basename(dir);
  const file = path.join(dir, "case.json");
  let prompt;
  let raw: Raw;
  try {
    prompt = fs.readFileSync(path.join(dir, "prompt.md"), "utf8").trim();
    raw = JSON.parse(fs.readFileSync(file, "utf8")) as Raw;
  } catch (error) {
    throw new UsageError(`case ${id}: ${messageOf(error)}`);
  }
  if (!prompt) throw new UsageError(`case ${id}: prompt.md is empty`);
  const checks = raw?.["checks"];
  if (!Array.isArray(checks) || checks.length === 0) {
    throw new UsageError(`${file}: "checks" must be a non-empty array`);
  }
  const minScore = raw?.["minScore"];
  if (minScore !== undefined && !isUnitScore(minScore)) {
    throw new UsageError(`${file}: minScore must be a number from 0 to 1`);
  }
  const workspaceDir = path.join(dir, "workspace");
  return {
    id,
    prompt,
    checks: checks.map((check: Raw, index) =>
      parseCheck(check, `${file} checks[${String(index)}]`),
    ),
    weight: weightOf(raw, file),
    minScore,
    maxTurns: positive(raw?.["maxTurns"], file, "maxTurns"),
    timeoutSeconds:
      positive(raw?.["timeoutSeconds"], file, "timeoutSeconds") ??
      DEFAULT_TIMEOUT_SECONDS,
    workspaceDir: fs.existsSync(workspaceDir) ? workspaceDir : null,
  };
}

/**
 * Loads the cases of a suite.
 * @param casesDir - A directory with one subdirectory for each case.
 * @param glob - Selects cases by id; only `*` is special.
 * @returns Every matching case, sorted by id.
 * @throws {UsageError} When the directory cannot be read, a case is invalid, or no case matches.
 */
export function loadCases(casesDir: string, glob = "*"): Case[] {
  const literal = (part: string): string =>
    part.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const matcher = new RegExp(`^${glob.split("*").map(literal).join(".*")}$`);
  let entries;
  try {
    entries = fs.readdirSync(casesDir, { withFileTypes: true });
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    throw new UsageError(
      `cannot read the cases directory ${casesDir} (${String(code)}); create it or pass --cases`,
    );
  }
  const cases = entries
    .filter((entry) => entry.isDirectory() && matcher.test(entry.name))
    .map((entry) => loadCase(path.join(casesDir, entry.name)))
    .sort((x, y) => x.id.localeCompare(y.id));
  if (cases.length === 0) {
    throw new UsageError(`no case in ${casesDir} matches "${glob}"`);
  }
  return cases;
}
