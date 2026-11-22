import fs from "node:fs";
import path from "node:path";
import { UsageError } from "./scope.js";
import type { Stripped, SubjectOptions } from "./subject-options.js";
import { needsHarness, pareSkills } from "./subject-options.js";
import { findSkills } from "./subject-skills.js";
import type { RulesOptions, SubjectRules } from "./subject-rules.js";
import { resolveRules } from "./subject-rules.js";

/** A harness, as far as an export's options are concerned. */
export interface Stripper {
  id: string;
  /** Removes hooks and agents from an export, and says which agents and skills it removed; absent for a harness that cannot. */
  strip?: ((dir: string, options: SubjectOptions) => Stripped) | undefined;
}

/** What shapes the export of one subject. */
export interface Variant {
  options: SubjectOptions;
  /** How the user named the subject, for the message. */
  flag: string;
  /** The harnesses that will run; each removes the files it owns. Absent: no harness is asked, as in `validate`. */
  strippers?: Stripper[] | undefined;
  /** The skill name of the export's own SKILL.md. */
  ownName: string;
  /** What an error message calls the subject's directory. */
  shown: string;
}

/**
 * Refuses a subject whose options a harness of the command cannot honour.
 * @param variant - The options, the flag and the harnesses.
 * @throws {UsageError} Naming the harnesses that cannot remove hooks or agents, when the options ask for it.
 */
export function requireStrippable(
  variant: Pick<Variant, "options" | "flag" | "strippers">,
): void {
  const { options, flag, strippers } = variant;
  if (!needsHarness(options) || strippers === undefined) return;
  const unable = strippers.filter((one) => one.strip === undefined);
  if (unable.length === 0) return;
  const asked = [
    ...(options.hooks ? ["hooks=off"] : []),
    ...(options.agents ? ["agents"] : []),
  ].join(" and ");
  throw new UsageError(
    `${flag}: ${asked} cannot be applied for ${unable.map((one) => one.id).join(", ")}, ${unable.length === 1 ? "which does" : "which do"} not say where ${unable.length === 1 ? "it reads" : "they read"} hooks and agents from; pick another harness with --harness`,
  );
}

/**
 * Applies the options of a subject spec to its export, a copy of the source: the skills are filtered by name, then each
 * harness removes what it owns.
 * @param root - The export.
 * @param variant - The options and what they need.
 * @returns The names of the agents and skills that were removed.
 * @throws {UsageError} When a skills option leaves no skill, or a file that holds hooks or agents cannot be read.
 */
export function applyOptions(root: string, variant: Variant): Stripped {
  const { options, strippers } = variant;
  const skills = options.skills
    ? pareSkills(
        findSkills(root, variant.ownName, variant.shown),
        options.skills,
        root,
      )
    : [];
  const stripped = (strippers ?? []).map(
    (one) => one.strip?.(root, options) ?? { agents: [], skills: [] },
  );
  return {
    agents: [...new Set(stripped.flatMap((one) => one.agents))],
    skills: [...new Set([...skills, ...stripped.flatMap((one) => one.skills)])],
  };
}

/**
 * Settles the rules of a subject under its `rules` option.
 * @param rules - The `rules` option; absent for the configured behaviour.
 * @param where - The config's rules, the export and the flag.
 * @param where.config - The config's `rules` and `instructionFile`.
 * @param where.root - The export.
 * @param where.flag - How the user named the subject.
 * @returns The rules to install. `rules=off` gives none, whatever the config says. `rules=on` gives the configured
 *   rules, or the Markdown files of a `rules/` directory of the subject when the config names none. Without the option
 *   the config decides.
 * @throws {UsageError} When `rules=on` finds no rules to install.
 */
export function rulesUnder(
  rules: SubjectOptions["rules"],
  where: { config: RulesOptions; root: string; flag: string },
): SubjectRules | null {
  const { config, root, flag } = where;
  if (rules === "off") return null;
  const named = resolveRules(config, root, flag);
  if (rules !== "on" || named !== null) return named;
  if (!fs.existsSync(path.join(root, "rules"))) {
    throw new UsageError(
      `${flag}: rules=on has no rules to install: the config names none, and the subject has no rules/ directory`,
    );
  }
  return resolveRules({ rules: "rules" }, root, flag);
}
