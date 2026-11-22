import type { Harness } from "./harnesses/shared.js";
import type { RulesFile } from "./harnesses/rules.js";
import { messageOf } from "./scope.js";

/** What installing a run's rules came to. */
export interface RulesInstalled {
  /** Where the files went, relative to the run's home or workspace; empty when the harness installs none. */
  installed: string[];
  /** Why the install failed, which makes the run invalid; null when it worked or there was nothing to install. */
  failure: string | null;
}

/**
 * Installs a subject's rules for a run.
 * @param harness - The adapter. Without `installRules` the rules are not installed and the run goes on.
 * @param files - The rule files and instruction file of the run's copy of the subject.
 * @param dirs - The run's home and workspace.
 * @param dirs.home - The run's home directory, where user-level files go.
 * @param dirs.workspace - The directory the agent works in.
 * @returns What was installed, or why it failed.
 */
export function installRulesFor(
  harness: Pick<Harness, "installRules" | "id">,
  files: RulesFile[],
  dirs: { home: string; workspace: string },
): RulesInstalled {
  if (files.length === 0 || harness.installRules === undefined) {
    return { installed: [], failure: null };
  }
  try {
    return { installed: harness.installRules(files, dirs), failure: null };
  } catch (error) {
    return {
      installed: [],
      failure: `could not install the rules for ${harness.id}: ${messageOf(error)}`,
    };
  }
}
