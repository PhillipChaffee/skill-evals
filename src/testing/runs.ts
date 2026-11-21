import fs from "node:fs";
import path from "node:path";
import type { RunRecord } from "../run.js";
import type { FakeScript } from "./plant.js";
import { script } from "./plant.js";
import type { Sandbox } from "./sandbox.js";
import { readResults } from "./sandbox.js";

/** One case to plant. */
interface PlantedCase {
  id: string;
  checks: unknown[];
  /** Default: `do <id>`, which is what `play` matches. */
  prompt?: string;
}

/**
 * Writes one case into a cases directory.
 * @param box - Where to write it.
 * @param dir - The cases directory, relative to the sandbox root.
 * @param planted - Its id, checks and prompt.
 */
export function writeCase(box: Sandbox, dir: string, planted: PlantedCase) {
  const { id, checks, prompt = `do ${id}` } = planted;
  box.write(`${dir}/${id}/prompt.md`, `${prompt}\n`);
  box.write(`${dir}/${id}/case.json`, { checks });
}

/** What `score` was asked to run. */
interface Scoring {
  subject: string;
  /** The absolute path of the cases directory. */
  cases: string;
  /** Default: 1. */
  reps?: number;
  /** Where the command runs. Default: the sandbox root. */
  cwd?: string;
  /** The output directory. Default: `results` in the sandbox. */
  out?: string;
}

/**
 * Runs `score` on a subject with the fake harness.
 * @param box - The sandbox.
 * @param scoring - What to run.
 * @returns The exit code, standard error, and the records of the run; none when the command wrote no results.
 */
export async function scoreSubject(box: Sandbox, scoring: Scoring) {
  const out = scoring.out ?? path.join(box.root, "results");
  const ran = await box.cli(
    [
      ...["score", "--subject", scoring.subject, "--cases", scoring.cases],
      ...["--reps", String(scoring.reps ?? 1), "--out", out],
    ],
    {},
    scoring.cwd,
  );
  const records: RunRecord[] = fs.existsSync(path.join(out, "results.json"))
    ? readResults(out).records
    : [];
  return { status: ran.status, stderr: ran.stderr, records };
}

/** What the scripted agent does for the cases whose prompt is `do <id>`. */
interface Scene {
  /** The script's file name. */
  name: string;
  /** The id of the case. */
  id: string;
  steps: FakeScript["turns"][number];
}

/**
 * Scripts the fake harness for one case.
 * @param box - The sandbox.
 * @param scene - What the agent does.
 */
export function play(box: Sandbox, scene: Scene) {
  script(box, scene.name, {
    match: { prompt: `do ${scene.id}` },
    turns: [[...scene.steps, { final: "done" }]],
  });
}

/**
 * Makes a scripted step that runs a shell command in the run's workspace.
 * @param command - The command; `$PLUGIN_DIR` is the plugin directory the harness was given.
 * @returns The step.
 */
export const exec = (command: string) => ({
  call: { name: "Bash", input: { command }, exec: true },
});
