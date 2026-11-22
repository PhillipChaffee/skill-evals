import fs from "node:fs";
import path from "node:path";
import { writeCase } from "./runs.js";
import type { Sandbox } from "./sandbox.js";

/** A check that the fake harness passes on every run: it writes `out/summary.txt`. */
export const SUMMARY = {
  type: "file_matches",
  path: "out/summary.txt",
  pattern: "summary",
};

/**
 * Plants cases that the fake harness passes.
 * @param box - The sandbox.
 * @param ids - The case ids.
 * @returns The absolute path of the cases directory.
 */
export function plantSuite(box: Sandbox, ids: string[]): string {
  for (const id of ids) writeCase(box, "suite", { id, checks: [SUMMARY] });
  return path.join(box.root, "suite");
}

/**
 * Counts how many times the fake harness has started.
 * @param box - The sandbox.
 * @returns The number of start markers; 0 when none.
 */
export const startsOf = (box: Sandbox): number =>
  fs.existsSync(box.started)
    ? fs.readFileSync(box.started, "utf8").trim().split("\n").length
    : 0;

/**
 * Cuts the fake harness's start log back, as if the command that wrote the rest had been stopped earlier.
 * @param box - The sandbox.
 * @param keep - How many start markers stay.
 */
export function keepStarts(box: Sandbox, keep: number): void {
  const lines = fs.readFileSync(box.started, "utf8").trim().split("\n");
  fs.writeFileSync(box.started, `${lines.slice(0, keep).join("\n")}\n`);
}

/**
 * Reads the lines of a results.jsonl.
 * @param out - The output directory.
 * @returns The text of each line.
 */
export const linesIn = (out: string): string[] =>
  fs
    .readFileSync(path.join(out, "results.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line !== "");
