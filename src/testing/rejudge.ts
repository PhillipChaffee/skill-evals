import fs from "node:fs";
import path from "node:path";
import type { Results } from "../evaluate.js";
import type { RunRecord } from "../run.js";
import { REPLIES_FILE } from "./judged.js";
import { plantCase, plugin } from "./plant.js";
import { readResults, sandbox } from "./sandbox.js";

/** A scored suite of one case, ready to be re-judged. */
export interface Scored {
  box: ReturnType<typeof sandbox>;
  /** The cases directory. */
  cases: string;
  /** The output directory that `score` wrote. */
  out: string;
  subject: string;
  /** Rewrites the checks of the case, leaving its prompt and files alone. */
  rewrite: (checks: unknown[]) => void;
  /** Runs `rejudge` on the output directory. */
  rejudge: (
    flags?: string[],
    env?: Record<string, string>,
  ) => ReturnType<ReturnType<typeof sandbox>["cli"]>;
}

/**
 * Scores the planted case `restate` with the fake harness.
 * @param checks - The checks of the case.
 * @param more - How to score.
 * @param more.flags - More flags of `score`.
 * @param more.replies - What the fake judge answers, in order.
 * @param more.answer - What the agent says; null for the fake's report of what it saw. Default: "It is fixed now."
 * @returns The sandbox, and what a test needs to re-judge it.
 */
export async function scoredWith(
  checks: unknown[],
  more: { flags?: string[]; replies?: string[]; answer?: string | null } = {},
): Promise<Scored> {
  const box = sandbox();
  const answer = more.answer === undefined ? "It is fixed now." : more.answer;
  const subject = plugin(
    box,
    "plugin-owned",
    answer === null ? {} : { answer },
  );
  const cases = plantCase(box, checks);
  if (more.replies) box.write(REPLIES_FILE, more.replies);
  const out = path.join(box.root, "results");
  const ran = await box.cli([
    ...["score", "--subject", subject, "--cases", cases],
    ...["--reps", "1", "--out", out, ...(more.flags ?? [])],
  ]);
  if (!fs.existsSync(path.join(out, RESULTS))) {
    throw new Error(`score failed: ${ran.stderr}`);
  }
  return {
    box,
    cases,
    out,
    subject,
    rewrite: (next) => {
      box.write("cases/restate/case.json", { checks: next });
    },
    rejudge: (flags = [], env = {}) =>
      box.cli(["rejudge", out, "--cases", cases, ...flags], env),
  };
}

/**
 * Reads a file of an output directory as JSON.
 * @param out - The output directory.
 * @param file - The file's name.
 * @returns The parsed results.
 */
export const resultsIn = (out: string, file = RESULTS): Results =>
  file === RESULTS
    ? readResults(out)
    : (JSON.parse(fs.readFileSync(path.join(out, file), "utf8")) as Results);

/**
 * Takes the only record of an output directory's results.
 * @param out - The directory that `score` wrote its files to.
 * @param file - The results file in it. Default: `results.json`.
 * @returns The first record of that file, which a test with one case and one rep has only.
 */
export function onlyRecord(out: string, file = RESULTS): RunRecord {
  const [record] = resultsIn(out, file).records;
  if (record === undefined) throw new Error("no record");
  return record;
}

/** A check that the planted agent's answer, "It is fixed now.", satisfies. */
export const FIXED = { type: "output_matches", pattern: "fixed" };
/** A check that it never satisfies. */
export const NEVER = { type: "output_matches", pattern: "zzz" };
/** The file that `rejudge` writes beside the results it read. */
export const REJUDGED = "results.rejudged.json";
/** A file that the planted case's workspace holds. */
export const NOTES = "notes.txt";
/** The file that `score` writes its results to. */
export const RESULTS = "results.json";
/** The flag that archives each run's files. */
export const KEEP = "--keep-workspaces";
/** What a case's held-out file holds. */
const HELD_OUT = "held out\n";

/**
 * Plants a held-out file in the case `restate`.
 * @param scored - The scored suite.
 */
export function plantGrader(scored: Scored): void {
  scored.box.write("cases/restate/grader/ok.txt", HELD_OUT);
}

/**
 * Plants a second case, `other`, with a prompt of its own.
 * @param scored - The scored suite.
 * @param checks - The checks of the case.
 */
export function plantOther(scored: Scored, checks: unknown[]): void {
  scored.box.write("cases/other/prompt.md", "do other\n");
  scored.box.write("cases/other/case.json", { checks });
}

/**
 * Makes a judged check.
 * @param rubric - What a good answer does.
 * @returns A binary judge check with that rubric.
 */
export const judged = (rubric: string) => ({
  type: "judge",
  rubric,
  scale: "binary",
});

/**
 * Reads a file.
 * @param file - Its path.
 * @returns Its text.
 */
export const read = (file: string): string => fs.readFileSync(file, "utf8");

/**
 * Counts the prompts that the fake judge has been given.
 * @param root - The sandbox's root.
 * @returns How many prompts it logged.
 */
export function promptsOf(root: string): number {
  const file = path.join(root, "fake/judge/prompts.jsonl");
  return fs.existsSync(file) ? read(file).trim().split("\n").length : 0;
}

/**
 * Scores the planted case again into another output directory.
 * @param scored - The scored suite.
 * @param name - The new directory's name under the sandbox root.
 * @param flags - More flags of `score`.
 * @returns The new output directory.
 */
export async function scoreInto(
  scored: Scored,
  name: string,
  flags: string[] = [],
): Promise<string> {
  const out = path.join(scored.box.root, name);
  await scored.box.cli([
    ...["score", "--subject", scored.subject, "--cases", scored.cases],
    ...["--reps", "1", "--out", out, ...flags],
  ]);
  return out;
}
