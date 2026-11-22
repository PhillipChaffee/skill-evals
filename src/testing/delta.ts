import fs from "node:fs";
import path from "node:path";
import type { Results } from "../evaluate.js";
import { plantCase, plugin } from "./plant.js";
import type { Behavior } from "./plant.js";
import { readResults } from "./sandbox.js";
import type { Sandbox } from "./sandbox.js";

/** Passes for every plugin: the fake harness writes `out/summary.txt` on every run. */
export const WRITES_SUMMARY = { type: "file_exists", path: "out/summary.txt" };
/** Passes only for a plugin whose agent loads the skill `bro`. */
export const LOADS_BRO = { type: "skill_loaded", skill: "bro" };
/** Fails for every plugin. */
export const NEVER = { type: "file_exists", path: "out/missing.txt" };

/** What `compared` runs. */
interface Comparing {
  /** The checks of the one case `restate`. */
  checks: unknown;
  /** More keys of its case file. */
  more?: Record<string, unknown>;
  /** What the first subject is: a path, or "none". Default: a plain plugin. */
  a?: string;
  /** What the second subject is. Default: a plugin whose agent loads `bro`. */
  b?: string;
  /** The behaviour of the plugin that is B, when `b` is not given. */
  behaviour?: Behavior;
  /** More flags of the command. */
  flags?: string[];
  /** The command: `run` by default. */
  command?: "run" | "calibrate";
  /** Default: 2. */
  reps?: number;
  /** The output directory under the sandbox root. Default: `results`. */
  out?: string;
}

/**
 * Runs one planted case against two plugins with the fake harness.
 * @param box - The sandbox.
 * @param comparing - The case and the flags.
 * @returns The command's result, its output directory, and `results.json` when the command wrote one.
 */
export async function compared(box: Sandbox, comparing: Comparing) {
  const { checks, more, flags = [], command = "run", reps = 2 } = comparing;
  const cases = plantCase(box, checks, more);
  const first = comparing.a ?? plugin(box, "plugin-alpha", {});
  const second =
    comparing.b ??
    plugin(box, "plugin-beta", comparing.behaviour ?? { skill: "bro" });
  const out = path.join(box.root, comparing.out ?? "results");
  const subjects =
    command === "run" ? ["--a", first, "--b", second] : ["--subject", first];
  const ran = await box.cli([
    command,
    ...subjects,
    ...["--cases", cases, "--reps", String(reps), "--out", out],
    ...flags,
  ]);
  const results: Results | null = fs.existsSync(path.join(out, "results.json"))
    ? readResults(out)
    : null;
  return { ran, out, results };
}

/**
 * Reads a file of the output directory as JSON.
 * @param out - The output directory.
 * @param file - The file's name.
 * @returns What it holds.
 */
export const readJson = (out: string, file: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(out, file), "utf8"));

/**
 * Writes a noise file that says every case and the suite move by a bound.
 * @param box - The sandbox.
 * @param bounds - The `maxAbsDelta` of each case id, and the suite's `p95AbsDelta`.
 * @param bounds.cases - The `maxAbsDelta` by case id.
 * @param bounds.suite - The suite's `p95AbsDelta`.
 * @returns The file's path.
 */
export const noiseFile = (
  box: Sandbox,
  bounds: { cases: Record<string, number>; suite: number },
): string =>
  box.write("noise.json", {
    schemaVersion: 1,
    perCase: Object.fromEntries(
      Object.entries(bounds.cases).map(([id, bound]) => [
        id,
        { sd: 0.1, maxAbsDelta: bound },
      ]),
    ),
    perCheckType: { file_exists: { sd: 0.1 } },
    suite: { sd: 0.1, p95AbsDelta: bounds.suite },
  });
