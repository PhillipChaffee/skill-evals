import path from "node:path";
import { fixtureOf, fixturesOf, homeOf } from "./case-dirs.js";
import type { FieldDef } from "./checks/fields.js";
import type { Found } from "./discover.js";
import type { SetupStep } from "./setup-steps.js";

// The keys of a case file that say what a run starts with besides `workspace/`.
export const LAYER_KEYS: Record<string, FieldDef> = {
  setup: {
    type: "steps",
    meaning:
      'A non-empty list of steps that run in the workspace, in order, before the agent starts: `{ "run": "<shell text>", "timeoutSeconds": 60 }` or `{ "git": { "init": true, "branch": "main", "commitAll": "<message>", "remote": "origin" } }`. A failed step makes the run invalid.',
  },
  home: {
    type: "text",
    meaning:
      "A directory of the case, copied into the run's throwaway home after the login files. It may not hold a file at the path of a harness's login file.",
  },
  fixtures: {
    type: "texts",
    meaning:
      "Directories, relative to the case's directory and inside the cases directory, copied into the workspace in order before the case's own `workspace/`. Keep shared ones under a directory that starts with `_`.",
  },
};

/**
 * Reads the keys and folders that decide what a run starts with besides `workspace/`.
 * @param found - The case's id and its directory.
 * @param read - Reads a key of the case file; undefined for a key the file leaves out.
 * @param root - The cases directory.
 * @returns The setup steps, the shared fixture directories, the case's `fixture/` and its home directory.
 */
export function layersOf(
  found: Found,
  read: (key: string) => unknown,
  root: string,
) {
  const { dir } = found;
  const file = path.join(dir, "case.json");
  return {
    setup: (read("setup") as SetupStep[] | undefined) ?? [],
    fixtureDirs: fixturesOf(
      { dir, file, root },
      read("fixtures") as string[] | undefined,
    ),
    fixtureDir: fixtureOf(dir, file),
    homeDir: homeOf(dir, file, read("home") as string | undefined),
  };
}
