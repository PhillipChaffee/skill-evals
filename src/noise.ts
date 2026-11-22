import fs from "node:fs";
import type { RunRecord } from "./run.js";
import { isUnitScore } from "./score.js";
import { UsageError, messageOf } from "./scope.js";
import type { Stratum } from "./stats.js";
import {
  RESAMPLES,
  mean,
  pooledSd,
  quantile,
  resampledDeltas,
  seedFor,
} from "./stats.js";

/** The name of the file that `calibrate` writes into its output directory. */
export const NOISE_FILE = "noise.json";

const P95 = 0.95;
const NOISE_KEYS = [
  "schemaVersion",
  "harness",
  "reps",
  "seed",
  "caseIds",
  "perCase",
  "perCheckType",
  "suite",
];

/** How much a measure moves between runs of one subject. */
interface Spread {
  /** The standard deviation. */
  sd: number;
}

/** What `calibrate` measured by running a subject against itself. `noise.json` holds it. */
export interface NoiseFile {
  /** The version of this file's shape. */
  schemaVersion: 1;
  /** The harness that was calibrated. The file is applied to that harness only. */
  harness: string;
  /** The reps of each subject in the calibration. A comparison at other reps gets a note. */
  reps: number;
  /** The seed of the calibration's bootstrap. */
  seed: number;
  /** The ids of the cases that were calibrated. A file that shares no id with the suite gets a note. */
  caseIds: string[];
  /** For each case id: `sd` is the run-score standard deviation pooled over the two sides, `maxAbsDelta` is |mean A - mean B|, for information, and `p95AbsDelta` is the 95th percentile of |delta*| over that case's A/A bootstrap, which is the bound a case's verdict uses. */
  perCase: Record<
    string,
    Spread & { maxAbsDelta: number; p95AbsDelta: number }
  >;
  /** For each check type: the standard deviation of that check's score over the reps of one case, pooled. */
  perCheckType: Record<string, Spread>;
  /** `sd` is the spread of the suite delta over the A/A bootstrap, `p95AbsDelta` the 95th percentile of its absolute value. */
  suite: Spread & { p95AbsDelta: number };
}

/**
 * Checks that a value is a plain object.
 * @param value - Anything.
 * @returns True for an object that is not null and not an array.
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Where in a noise file a value was read, for a message. */
interface Where {
  file: string;
  /** The path of the value, as in `perCase.restate.sd`. */
  at: string;
}

/**
 * Checks that a field holds a number from 0 to 1.
 * @param where - The file and the path of the field.
 * @param value - What the file holds there.
 * @throws {UsageError} When it is not a finite number from 0 to 1.
 */
function requireUnit(where: Where, value: unknown): void {
  if (typeof value !== "number" || !isUnitScore(value)) {
    throw new UsageError(
      `${where.file}: "${where.at}" must be a number from 0 to 1`,
    );
  }
}

/**
 * Checks one object that must hold exactly the number fields given.
 * @param where - The file and the path of the object.
 * @param entry - What the file holds there.
 * @param fields - The names of the number fields it must hold.
 * @throws {UsageError} When it is not an object, lacks a field, has another, or holds a bad number.
 */
function requireFields(where: Where, entry: unknown, fields: string[]): void {
  if (!isRecord(entry)) {
    throw new UsageError(`${where.file}: "${where.at}" must be an object`);
  }
  for (const field of Object.keys(entry)) {
    if (!fields.includes(field)) {
      throw new UsageError(
        `${where.file}: "${where.at}" has an unknown key "${field}"; it takes ${fields.join(", ")}`,
      );
    }
  }
  for (const field of fields) {
    requireUnit({ ...where, at: `${where.at}.${field}` }, entry[field]);
  }
}

/**
 * Checks an object whose keys are free and whose values hold fixed number fields.
 * @param where - The file and the path of the object.
 * @param value - What the file holds there.
 * @param fields - The names of the number fields each entry must hold.
 * @throws {UsageError} When it is not an object, or an entry is wrong.
 */
function requireEntries(where: Where, value: unknown, fields: string[]): void {
  if (!isRecord(value)) {
    throw new UsageError(`${where.file}: "${where.at}" must be an object`);
  }
  for (const [key, entry] of Object.entries(value)) {
    requireFields({ ...where, at: `${where.at}.${key}` }, entry, fields);
  }
}

/**
 * Reads a noise file, strictly.
 * @param file - The path, from `--noise` or the config key `noise`.
 * @returns What `calibrate` wrote there.
 * @throws {UsageError} When the file cannot be read or is not JSON, or its shape is not that of `NoiseFile`: a wrong
 *   `schemaVersion`, a missing or unknown key, or a value out of range. The message names the file and the field.
 */
export function readNoise(file: string): NoiseFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new UsageError(
      `${file}: cannot read the noise file: ${messageOf(error)}`,
    );
  }
  if (!isRecord(parsed))
    throw new UsageError(`${file}: must hold one JSON object`);
  for (const key of Object.keys(parsed)) {
    if (!NOISE_KEYS.includes(key)) {
      throw new UsageError(
        `${file}: unknown key "${key}"; a noise file has ${NOISE_KEYS.join(", ")}`,
      );
    }
  }
  const absent = NOISE_KEYS.filter((key) => !Object.hasOwn(parsed, key));
  if (absent.length > 0) {
    throw new UsageError(
      `${file}: missing ${absent.map((key) => `"${key}"`).join(", ")}; write the file again with \`calibrate\``,
    );
  }
  if (parsed["schemaVersion"] !== 1) {
    throw new UsageError(
      `${file}: "schemaVersion" must be 1, as \`calibrate\` writes it`,
    );
  }
  const at = (name: string): Where => ({ file, at: name });
  const { harness, reps, seed, caseIds } = parsed;
  if (typeof harness !== "string" || harness === "") {
    throw new UsageError(`${file}: "harness" must be a harness id`);
  }
  for (const [name, value] of [
    ["reps", reps],
    ["seed", seed],
  ] as const) {
    if (!Number.isInteger(value) || (value as number) < 1) {
      throw new UsageError(`${file}: "${name}" must be a positive integer`);
    }
  }
  if (!Array.isArray(caseIds) || caseIds.some((id) => typeof id !== "string")) {
    throw new UsageError(`${file}: "caseIds" must be a list of case ids`);
  }
  requireEntries(at("perCase"), parsed["perCase"], [
    "sd",
    "maxAbsDelta",
    "p95AbsDelta",
  ]);
  requireEntries(at("perCheckType"), parsed["perCheckType"], ["sd"]);
  requireFields(at("suite"), parsed["suite"], ["sd", "p95AbsDelta"]);
  return parsed as unknown as NoiseFile;
}

/** The runs of a case, by subject label. */
type Sides = { a: number[]; b: number[] };

/**
 * Groups the valid run scores of every case by side.
 * @param records - Every run of one harness.
 * @returns For each case id, the valid run scores of A and of B, in plan order.
 */
function sidesOf(records: RunRecord[]): Map<string, Sides> {
  const cases = new Map<string, Sides>();
  for (const { caseId, subject, score } of records) {
    if (score === null || (subject !== "a" && subject !== "b")) continue;
    const sides = cases.get(caseId) ?? { a: [], b: [] };
    sides[subject].push(score);
    cases.set(caseId, sides);
  }
  return cases;
}

/**
 * Groups a check's scores over the reps of one case and side, by check type.
 * @param records - Every run of one harness.
 * @returns For each check type, one group of scores for each case, check and side.
 */
function checkGroups(records: RunRecord[]): Map<string, number[][]> {
  const groups = new Map<string, number[]>();
  const types = new Map<string, string>();
  for (const record of records) {
    if (record.score === null) continue;
    for (const [at, check] of record.checks.entries()) {
      if (check.score === null) continue;
      const key = `${record.caseId}\u0000${String(at)}\u0000${record.subject}`;
      groups.set(key, [...(groups.get(key) ?? []), check.score]);
      types.set(key, check.type);
    }
  }
  const byType = new Map<string, number[][]>();
  for (const [key, scores] of groups) {
    const type = types.get(key) ?? "";
    byType.set(type, [...(byType.get(type) ?? []), scores]);
  }
  return byType;
}

/**
 * Takes the 95th percentile of the absolute values of resampled deltas.
 * @param deltas - The resampled deltas.
 * @returns The 95th percentile of their absolute values.
 */
const p95Of = (deltas: number[]): number =>
  quantile(
    deltas.map(Math.abs).sort((x, y) => x - y),
    P95,
  );

/**
 * Measures how much a subject moves against itself.
 * @param records - The runs of one harness, scored with A and B the same subject; invalid runs are left out.
 * @param calibration - What was calibrated.
 * @param calibration.harness - The harness id.
 * @param calibration.reps - The reps of each subject.
 * @param calibration.seed - The seed of the bootstrap.
 * @param calibration.caseIds - The ids of the cases that ran.
 * @param calibration.weights - The weight of each case in the suite score, by case id; a case that is not listed counts 1.
 * @returns The noise file; null when no case has a valid run on both sides, since nothing was measured.
 */
export function noiseOf(
  records: RunRecord[],
  calibration: {
    harness: string;
    reps: number;
    seed: number;
    caseIds: string[];
    weights: Record<string, number>;
  },
): NoiseFile | null {
  const { seed, weights } = calibration;
  const sides = [...sidesOf(records)].filter(
    ([, { a, b }]) => a.length > 0 && b.length > 0,
  );
  if (sides.length === 0) return null;
  const strata: Stratum[] = sides.map(([id, { a, b }]) => ({
    a,
    b,
    weight: weights[id] ?? 1,
  }));
  const deltas = resampledDeltas(strata, {
    resamples: RESAMPLES,
    seed: seedFor(seed, "calibrate"),
  });
  return {
    schemaVersion: 1,
    harness: calibration.harness,
    reps: calibration.reps,
    seed,
    caseIds: calibration.caseIds,
    perCase: Object.fromEntries(
      sides.map(([id, { a, b }]) => [
        id,
        {
          sd: pooledSd([a, b]),
          maxAbsDelta: Math.abs(mean(a) - mean(b)),
          p95AbsDelta: p95Of(
            resampledDeltas([{ a, b, weight: 1 }], {
              resamples: RESAMPLES,
              seed: seedFor(seed, `calibrate\u0000${id}`),
            }),
          ),
        },
      ]),
    ),
    perCheckType: Object.fromEntries(
      [...checkGroups(records)].map(([type, groups]) => [
        type,
        { sd: pooledSd(groups) },
      ]),
    ),
    suite: {
      sd: pooledSd([deltas]),
      p95AbsDelta: p95Of(deltas),
    },
  };
}
