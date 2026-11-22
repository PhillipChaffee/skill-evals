import fs from "node:fs";
import path from "node:path";
import { plantCase, script, skillsFolder } from "./plant.js";
import type { FakeScript } from "./plant.js";
import type { Sandbox } from "./sandbox.js";
import { readResults } from "./sandbox.js";

const EXECUTABLE = 0o755;

/** What a scripted run of a case with held-out files needs besides its checks. */
export interface Graded {
  checks: unknown[];
  /** Files of the case's `grader/` directory. */
  grader?: Record<string, string>;
  /** Files of the case's `workspace/`, besides `notes.txt`. */
  workspace?: Record<string, string>;
  /** Paths of `workspace/` to make executable. */
  executable?: string[];
  /** What the agent does before it ends. */
  agent?: FakeScript["turns"][number];
  /** Extra environment of the command line, such as a key that must not reach the commands. */
  env?: Record<string, string>;
}

/**
 * Scores the planted case once with a scripted agent.
 * @param box - The sandbox.
 * @param graded - The checks, the files of `grader/` and `workspace/`, and the agent's steps.
 * @returns The command's result, the output directory, and the parsed results; null when none were written.
 */
export async function scoreGraded(box: Sandbox, graded: Graded) {
  const cases = plantCase(box, graded.checks);
  for (const [name, content] of Object.entries(graded.grader ?? {})) {
    box.write(`cases/restate/grader/${name}`, content);
  }
  for (const [name, content] of Object.entries(graded.workspace ?? {})) {
    box.write(`cases/restate/workspace/${name}`, content);
  }
  for (const name of graded.executable ?? []) {
    fs.chmodSync(
      path.join(box.root, "cases/restate/workspace", name),
      EXECUTABLE,
    );
  }
  script(box, "agent", {
    turns: [[...(graded.agent ?? []), { final: "done" }]],
  });
  const out = path.join(box.root, "results");
  const subject = skillsFolder(box, "skills", { bro: "# bro\n" });
  const args = ["score", "--subject", subject, "--cases", cases];
  const result = await box.cli(
    [...args, ...["--reps", "1", "--out", out]],
    graded.env,
  );
  return {
    ...result,
    out,
    results: fs.existsSync(path.join(out, "results.json"))
      ? readResults(out)
      : null,
  };
}
