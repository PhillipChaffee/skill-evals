import path from "node:path";
import type { FakeScript } from "./plant.js";
import { script } from "./plant.js";
import { writeCase } from "./runs.js";
import type { Sandbox } from "./sandbox.js";
import { SUMMARY } from "./suite.js";

/** The step that makes the file which `SUMMARY` checks for. */
const WRITE_SUMMARY = {
  call: {
    name: "Write",
    input: {},
    write: { path: "out/summary.txt", content: "summary" },
  },
};

/** What a scripted case of a suite does besides writing the summary. */
interface Scripted {
  /** The `total_cost_usd` of the case's runs. */
  costUsd?: number;
  /** Steps played before the summary is written. */
  before?: FakeScript["turns"][number];
  /** More keys of the case file, such as `timeoutSeconds`. */
  more?: Record<string, unknown>;
  /** More checks, after the file check. */
  checks?: unknown[];
  /** Replaces the script's `noInit`. */
  noInit?: boolean;
}

/**
 * Plants a case that a script of the fake harness plays: it does `before`, writes the summary and says it is done.
 * @param box - The sandbox.
 * @param id - The case id, which its prompt `do <id>` names.
 * @param scripted - What the script does and what the case file adds.
 * @returns The absolute path of the cases directory.
 */
export function scriptedCase(
  box: Sandbox,
  id: string,
  scripted: Scripted = {},
): string {
  const { costUsd, before = [], more = {}, checks = [], noInit } = scripted;
  writeCase(box, "suite", { id, checks: [SUMMARY, ...checks] });
  if (Object.keys(more).length > 0) {
    box.write(`suite/${id}/case.json`, {
      checks: [SUMMARY, ...checks],
      ...more,
    });
  }
  script(box, `case-${id}`, {
    match: { prompt: `do ${id}` },
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(noInit === undefined ? {} : { noInit }),
    turns: [[...before, WRITE_SUMMARY, { final: "done" }]],
  });
  return path.join(box.root, "suite");
}

/**
 * Builds the arguments of a `score` command on the planted suite.
 * @param box - The sandbox.
 * @param out - The output directory, relative to the sandbox root.
 * @param more - More arguments.
 * @returns The arguments.
 */
export const scoreArgs = (
  box: Sandbox,
  out: string,
  ...more: string[]
): string[] => [
  ...["score", "--subject", "none", "--reps", "1"],
  ...["--cases", path.join(box.root, "suite")],
  ...["--out", path.join(box.root, out)],
  ...more,
];

/**
 * Builds the arguments of a `score` command that continues an earlier one on the planted suite.
 * @param box - The sandbox.
 * @param out - The output directory of the earlier command, relative to the sandbox root.
 * @param more - More arguments.
 * @returns The arguments.
 */
export const resumeArgs = (
  box: Sandbox,
  out: string,
  ...more: string[]
): string[] => [
  ...["score", "--subject", "none", "--reps", "1"],
  ...["--cases", path.join(box.root, "suite")],
  ...["--resume", path.join(box.root, out)],
  ...more,
];

/**
 * Plants cases that the fake harness runs with a stated cost each.
 * @param box - The sandbox.
 * @param ids - The case ids.
 * @param costUsd - What each run costs.
 */
export function priced(box: Sandbox, ids: string[], costUsd: number) {
  for (const id of ids) scriptedCase(box, id, { costUsd });
}
