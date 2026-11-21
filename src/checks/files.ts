import fs from "node:fs";
import path from "node:path";
import { holds, regex } from "./rules.js";
import type { Outcome, With } from "./index.js";

/**
 * Reads the file a check names.
 * @param check - A check with a path, which loading the case kept inside the workspace.
 * @param outcome - Where the workspace is.
 * @returns The file's text, or null when it cannot be read.
 */
function fileText(check: With<"path">, outcome: Outcome): string | null {
  try {
    return fs.readFileSync(path.join(outcome.workspace, check.path), "utf8");
  } catch {
    return null;
  }
}

// The checks of the files the run left in the workspace.
export const FILE_CHECKS = {
  file_exists: holds(
    ["path"],
    (check, outcome) => fileText(check, outcome) !== null,
    { scores: "That file exists in the workspace after the run." },
  ),
  file_matches: holds(
    ["path", "pattern"],
    (check, outcome) => {
      const text = fileText(check, outcome);
      return text !== null && regex(check.pattern, check.flags).test(text);
    },
    {
      optional: ["flags"],
      scores: "That file exists and matches the regular expression.",
    },
  ),
};
