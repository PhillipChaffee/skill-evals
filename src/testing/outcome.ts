import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { onTestFinished } from "vitest";
import type { CommandContext } from "../command.js";
import type { Outcome, RuledCheck, Verdict } from "../checks/index.js";
import { checkScore } from "../checks/index.js";
import { NOT_REPORTED } from "../harnesses/shared.js";
import { fileState } from "../run-files.js";
import { snapshot } from "../snapshot.js";

/** The state of the files of a run that changed nothing. */
export const NO_FILES = {
  seed: new Map<string, string>(),
  changed: { created: [], modified: [], deleted: [] },
  unlisted: [] as string[],
  home: "",
  homeSeed: new Map<string, string>(),
  homeChanged: { created: [], modified: [], deleted: [] },
  homeUnlisted: [] as string[],
  // A command that looks at nothing: the workspace is where the test put it, and no held-out directory exists.
  command: {
    workspace: "",
    graderDir: null,
    seedDir: "",
    home: "",
    transcriptFile: null,
    remoteDir: null,
    env: {},
  } as CommandContext,
};

/**
 * Makes an outcome of a run that looked at no files.
 * @param more - Fields to set besides the empty ones.
 * @returns An outcome with no calls, no skills and empty seeds, and the fields given.
 */
const bareOutcome = (more: Partial<Outcome> = {}): Outcome => ({
  finalText: "",
  toolCalls: [],
  skillEvents: [],
  loaded: NOT_REPORTED,
  workspace: "",
  subject: { dir: null, mutated: [] },
  ...NO_FILES,
  ...more,
});

/** A directory to hold the files of a test run: the workspace and the home, each already seeded. */
export interface Dirs {
  workspace: string;
  home: string;
  /** Writes a file under the workspace, making its directories. */
  put: (relative: string, content?: string | Buffer) => void;
  /** Takes the seed snapshots, runs `agent` with the directories, and returns the outcome of what it left. */
  run: (agent?: (dirs: { workspace: string; home: string }) => void) => Outcome;
}

/**
 * Makes a throwaway workspace and home that are removed when the test ends.
 * @param seed - Files the workspace holds before the agent runs, from relative path to text.
 * @returns The directories, and a function that plays the agent and builds the outcome.
 */
export function dirsWith(seed: Record<string, string> = {}): Dirs {
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "files-")),
  );
  onTestFinished(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });
  const workspace = path.join(base, "proj");
  const home = path.join(base, "home");
  fs.mkdirSync(workspace);
  fs.mkdirSync(home);
  const put = (relative: string, content: string | Buffer = ""): void => {
    const file = path.join(workspace, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  for (const [relative, content] of Object.entries(seed))
    put(relative, content);
  return {
    workspace,
    home,
    put,
    run: (agent = () => undefined) => {
      const before = snapshot(workspace);
      const homeBefore = snapshot(home);
      agent({ workspace, home });
      return bareOutcome({
        ...fileState({ workspace, seed: before, home, homeSeed: homeBefore }),
        command: {
          ...NO_FILES.command,
          workspace,
          seedDir: workspace,
          home,
        },
      });
    },
  };
}

/** A check as a test writes it, without its weight. */
export type Given = Omit<RuledCheck, "weight">;

/**
 * Scores a check whose rule does not wait for a process.
 * @param check - The check, with its weight.
 * @param outcome - What the run left behind.
 * @returns Its verdict.
 */
export const scoredNow = (check: RuledCheck, outcome: Outcome): Verdict =>
  checkScore(check, outcome) as Verdict;

/**
 * Scores one check against an outcome.
 * @param check - The check, with the fields its type takes.
 * @param outcome - What the run left behind.
 * @returns Its verdict.
 */
export const scored = (check: Given, outcome: Outcome) =>
  scoredNow({ ...check, weight: 1 }, outcome);

/**
 * Scores one check against an outcome, waiting for a rule that runs a process.
 * @param check - The check, with the fields its type takes.
 * @param outcome - What the run left behind.
 * @returns Its verdict.
 */
export const scoredAsync = async (
  check: Given,
  outcome: Outcome,
): Promise<Verdict> => checkScore({ ...check, weight: 1 }, outcome);
