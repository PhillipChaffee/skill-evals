import fs from "node:fs";
import path from "node:path";
import { CONFIG_FILE } from "../project.js";
import type { Sandbox } from "./sandbox.js";
import { fixture, readResults } from "./sandbox.js";

const SLOW_ENV = ["SLOW_HEARTBEAT_FILE", "SLOW_PID_FILE", "SLOW_TURNS"];

/** How one run of the "hello" case is made. */
export interface Hello {
  /** Environment variables of the command; `SKILL_EVALS_BIN_*` choose the harness executable. */
  env?: Record<string, string>;
  /** More keys for the case file. */
  caseFile?: Record<string, unknown>;
  /** More flags for the command. */
  flags?: string[];
}

/**
 * Scores the "none" subject once on a case that any finished run passes.
 * @param box - Where the case goes.
 * @param run - The environment, the case's other keys and the flags.
 * @returns What the command did, and the one run record.
 */
export async function scored(box: Sandbox, run: Hello = {}) {
  box.write("cases/hello/prompt.md", "say hello\n");
  const checks = [{ type: "output_not_contains", text: "no such text" }];
  box.write("cases/hello/case.json", { checks, ...run.caseFile });
  const outDir = path.join(box.root, "results");
  const flags = ["--cases", path.join(box.root, "cases"), "--reps", "1"];
  const result = await box.cli(
    [
      "score",
      "--subject",
      "none",
      ...flags,
      ...(run.flags ?? []),
      "--out",
      outDir,
    ],
    run.env,
  );
  return { result, record: readResults(outDir).records[0] };
}

/**
 * Runs the slow harness, which writes `turns` assistant events and then never answers.
 * @param box - Where the case goes.
 * @param turns - How many events it writes first; 0 writes none.
 * @param caseFile - More keys for the case file.
 * @returns What `scored` returns, and the files that the slow harness writes.
 */
export async function slowRun(
  box: Sandbox,
  turns: number,
  caseFile: Record<string, unknown>,
) {
  const files = {
    heartbeat: path.join(box.root, "heartbeat"),
    pid: path.join(box.root, "pid"),
  };
  box.write(CONFIG_FILE, { env: SLOW_ENV });
  const env = {
    SKILL_EVALS_BIN_CLAUDE_CODE: fixture("slow-harness.mjs"),
    SLOW_HEARTBEAT_FILE: files.heartbeat,
    SLOW_PID_FILE: files.pid,
    SLOW_TURNS: String(turns),
  };
  return { ...(await scored(box, { env, caseFile })), files };
}

/**
 * Tells whether a process is gone; a zombie that nothing has reaped yet counts as gone.
 * @param pid - The process id.
 * @returns True when no live process has that id.
 */
export function gone(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  try {
    return /^\d+ \(.*\) Z/.test(
      fs.readFileSync(`/proc/${String(pid)}/stat`, "utf8"),
    );
  } catch {
    return true;
  }
}
