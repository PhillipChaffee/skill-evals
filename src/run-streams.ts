import fs from "node:fs";
import path from "node:path";
import { writeHistory } from "./history-file.js";
import type { RunPlan } from "./run-plan.js";
import type { SessionResult } from "./session.js";
import { writeTranscript } from "./transcript.js";

/**
 * Names the files of a run.
 * @param plan - The run.
 * @returns Its path without an extension, under the output directory.
 */
const stemOf = (plan: RunPlan): string =>
  path.join(
    plan.outDir,
    plan.harness.id,
    plan.caseDef.id,
    `${plan.subject.label}${String(plan.rep)}`,
  );

/**
 * Writes the run's stream, final text and transcript under the output directory.
 * @param plan - The run that was made.
 * @param ran - What the session produced.
 * @returns The transcript file: its absolute path, and its path relative to the output directory.
 */
export function writeStreams(
  plan: RunPlan,
  ran: SessionResult,
): {
  absolute: string;
  relative: string;
  history: string | null;
  /** The paths that a `command` check gets: `SKILL_EVALS_TRANSCRIPT` and `SKILL_EVALS_HISTORY`. */
  files: { transcript: string; history: string | null };
  stem: string;
} {
  const stem = stemOf(plan);
  fs.mkdirSync(path.dirname(stem), { recursive: true });
  fs.writeFileSync(`${stem}.stream.jsonl`, ran.stdout);
  fs.writeFileSync(`${stem}.final.md`, ran.parsed.finalText);
  // What the mock MCP servers logged is kept beside the transcript, as the servers wrote it.
  if (ran.mcpLog !== null)
    fs.writeFileSync(`${stem}.mock-log.jsonl`, ran.mcpLog);
  const absolute = path.resolve(writeTranscript(stem, ran.parsed.transcript));
  // The seeded history is a file of its own, so that the transcript holds the agent's events only.
  const history = writeHistory(stem, ran.seeded);
  return {
    absolute,
    relative: path.relative(path.resolve(plan.outDir), absolute),
    history,
    files: { transcript: absolute, history },
    stem,
  };
}
