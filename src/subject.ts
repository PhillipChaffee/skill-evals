import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { NO_EXCLUSIONS, globsFor } from "./exclusions.js";
import type { Exclusions } from "./exclusions.js";
import { exportSubject, leaveOut } from "./isolate.js";
import type { Stripped } from "./subject-options.js";
import { parseSpec } from "./subject-options.js";
import { findSkills } from "./subject-skills.js";
import type { Stripper } from "./subject-variant.js";
import {
  applyOptions,
  requireStrippable,
  rulesUnder,
} from "./subject-variant.js";
import type { Project } from "./project.js";
import { UsageError } from "./scope.js";
import { hashTree } from "./tree-hash.js";
import type { RulesOptions, SubjectRules } from "./subject-rules.js";
import { allChanged, diffSnapshots, snapshot } from "./snapshot.js";

/**
 * A subject's name in the results. A comparison of two has the labels "a" and "b", a single subject is "subject", and
 * `--subjects name=spec,...` names each one: lowercase letters, digits and hyphens, starting with a letter.
 */
export type Label = string;

/** The part of a subject that goes into `results.json` and the report. */
export interface SubjectSummary {
  label: Label;
  /** What the user named: "none", a directory, or a git ref of the project; without the options after its colon. */
  spec: string;
  /**
   * The options of the spec in one canonical text, such as `hooks=off,skills=only:magic-*`. Absent from the results of
   * a subject that has none, which is every subject of 0.0.1.
   */
  options?: string;
  /**
   * "plugin" is a directory with a harness's plugin packaging, loaded the way that harness loads a local plugin;
   * "skills" is a plain folder of skills, copied to where each harness discovers skills; "none" loads nothing.
   */
  kind: "plugin" | "skills" | "none";
  /** Null for "none". What the user named; for a git ref, the project. A run loads a copy of it, never this. */
  dir: string | null;
  /** The names of the skills found in dir, sorted. */
  skills: string[];
  /** Set when spec is a git ref. */
  commit: string | null;
}

/** What a run loads into the harness. */
export interface Subject extends SubjectSummary {
  /** Skill name to its directory in `dir`. */
  skillDirs: Record<string, string>;
  /** A plugin's own name from its manifest, which prefixes its skills in the skill tool; null for any other subject. */
  pluginName: string | null;
  /** The export that every run copies; null for "none". It has left out what the subject excludes. */
  exported: string | null;
  /** Lists what a run edited in the export, which would reach later runs; none unless one did. */
  exportChanged: () => string[];
  /**
   * The rules the subject names (`rules`, `instructionFile` of the config), which the adapter installs; null when the
   * config names none, and always null for "none".
   */
  rules: SubjectRules | null;
  /** The options of the spec in one canonical text; "" for none. */
  options: string;
  /** The agents and skills that the options removed from the export, which a harness must not report as loaded. */
  stripped: Stripped;
  /** Whether the spec said `rules=on` or `rules=off`; null when it said neither, so the configured behaviour applies. */
  rulesOption: "on" | "off" | null;
  /** The paths of the source directory that changed since the subject was resolved; none for a git ref and "none". */
  sourceChanges: () => string[];
  /**
   * What a reused result must share: the content hash of the export, which has left out what the subject excludes, for
   * a directory and for a git ref alike; "none" for "none".
   */
  revision: string;
  /** Removes the export. */
  dispose: () => void;
}

/**
 * Reads a plugin's own name, which prefixes its skills in a harness's skill tool (`<name>:<skill>`).
 * @param dir - The plugin directory.
 * @returns The `name` of the first manifest that has one; null when the directory is no plugin or no manifest names it.
 */
function pluginNameOf(dir: string): string | null {
  const manifests = [
    ...PLUGIN_MARKERS.filter((marker) => marker.endsWith("plugin.json")),
    "package.json",
  ];
  for (const manifest of manifests) {
    try {
      const { name } = JSON.parse(
        fs.readFileSync(path.join(dir, manifest), "utf8"),
      ) as { name?: unknown };
      if (typeof name === "string" && name !== "") return name;
    } catch {
      // No such manifest, or not JSON: the next one may name the plugin.
    }
  }
  return null;
}

/** What only a subject that is not "none" has. */
interface WithContent {
  kind: "plugin" | "skills";
  dir: string;
}

/**
 * Tells a subject with a directory from the "none" baseline.
 * @param subject - A subject or its summary.
 * @returns True for a plugin or a skills folder, which narrows `dir` to a string.
 */
export const hasContent = <S extends Pick<SubjectSummary, "kind" | "dir">>(
  subject: S,
): subject is S & WithContent => subject.kind !== "none";

const PLUGIN_MARKERS = [
  ".claude-plugin/plugin.json",
  ".cursor-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  "plugin.json",
  ".opencode/plugins",
];

/**
 * Tells whether a directory carries any harness's plugin packaging.
 * @param dir - The directory to look in.
 * @returns True for a plugin manifest of Claude Code, Cursor, Codex, or OpenCode, or a package.json with a `pi` key.
 */
function isPlugin(dir: string): boolean {
  if (PLUGIN_MARKERS.some((marker) => fs.existsSync(path.join(dir, marker)))) {
    return true;
  }
  try {
    const manifest: unknown = JSON.parse(
      fs.readFileSync(path.join(dir, "package.json"), "utf8"),
    );
    return (
      typeof manifest === "object" && manifest !== null && "pi" in manifest
    );
  } catch {
    return false;
  }
}

const git = (repoDir: string, ...args: string[]): string =>
  execFileSync("git", ["-C", repoDir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/** Where a subject's files are, before they are exported. */
interface Located {
  /** A directory as it is on disk, or the project for a git ref. */
  dir: string;
  commit: string | null;
}

/**
 * Locates the files of a subject. A directory is used as it is. Anything else must be a git ref of the project.
 * @param flag - How the user named the subject, for an error message.
 * @param spec - A directory, relative to the working directory, or a git ref.
 * @param project - Where a ref is looked up.
 * @returns The directory, or the project and the commit of the ref.
 * @throws {UsageError} When spec is neither a directory nor a ref of the project.
 */
function locate(flag: string, spec: string, project: Project): Located {
  const dir = path.resolve(project.cwd, spec);
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
    return { dir: fs.realpathSync(dir), commit: null };
  }
  if (!project.isGitRepo) {
    throw new UsageError(
      `${flag}: not a directory, and it cannot be a git ref because ${project.root} is not in a git repository`,
    );
  }
  let commit;
  try {
    commit = git(
      project.root,
      "rev-parse",
      "--verify",
      "--quiet",
      `${spec}^{commit}`,
    );
  } catch {
    throw new UsageError(
      `${flag}: not a directory and not a git ref of ${project.root}`,
    );
  }
  return { dir: project.root, commit };
}

/** Where a command's subjects are looked up, and what their exports leave out. */
export interface SubjectScope extends Project {
  /** Default: nothing besides `.git` and `node_modules`. */
  left?: Exclusions;
  /** The config's `rules` and `instructionFile`. Default: none. */
  rules?: RulesOptions;
  /** The harnesses that will run, which remove the hooks and agents that a spec switches off. Default: none is asked. */
  strippers?: Stripper[];
  /** True when the subject came from `--subjects`, which names it in errors as `--subjects <label>`. Default: false. */
  named?: boolean;
}

/**
 * Exports a subject, and words a failure with the flag it came from.
 * @param flag - How the user named the subject, such as `--a main`, for the message.
 * @param source - Where the files are.
 * @param shape - What the export leaves out, and what it changes before it is hashed.
 * @param shape.globs - What the export leaves out.
 * @param shape.modify - Changes the export; the options of the spec are applied here.
 * @returns The directory of the export and the `dispose` that removes it.
 * @throws {UsageError} When the export fails.
 */
function exportNamed(
  flag: string,
  source: Parameters<typeof exportSubject>[0],
  shape: { globs: string[]; modify: (dir: string) => void },
): ReturnType<typeof exportSubject> {
  try {
    return exportSubject(source, shape.globs, shape.modify);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    throw new UsageError(`${flag}: ${error.message}`);
  }
}

/**
 * Makes the baseline subject, which loads nothing.
 * @param label - The subject's place in the comparison.
 * @returns The subject.
 */
const baseline = (label: Label): Subject => ({
  label,
  spec: "none",
  kind: "none",
  dir: null,
  skills: [],
  skillDirs: {},
  pluginName: null,
  commit: null,
  exported: null,
  exportChanged: () => [],
  rules: null,
  options: "",
  stripped: { agents: [], skills: [] },
  rulesOption: null,
  sourceChanges: () => [],
  revision: "none",
  dispose: () => undefined,
});

/**
 * Names how the user gave a subject, for an error message.
 * @param label - The subject's label.
 * @param given - The spec as typed, options included.
 * @param named - True for a subject of `--subjects`.
 * @returns `--subjects <label>=<spec>` for a named subject; else `--a <spec>`, `--b <spec>` or `--subject <spec>`.
 */
const flagOf = (label: Label, given: string, named: boolean): string =>
  named || !["a", "b", "subject"].includes(label)
    ? `--subjects ${label}=${given}`
    : `--${label} ${given}`;

/**
 * Turns what the user named into something a harness can load. A subject is never loaded in place: it is exported
 * once, and each run loads its own copy of the export. The options of the spec (`<spec>:hooks=off,...`) are applied to
 * that export only: the source is never touched.
 * @param label - The subject's place in the comparison.
 * @param given - `none`, a directory (as it is on disk, uncommitted changes included), or a git ref of the project,
 *   followed by `:` and options when it has any. An existing path that holds a colon is a path, not a spec with options.
 * @param scope - What a relative directory and a ref resolve against, what the export leaves out besides `.git` and
 *   `node_modules`, and the harnesses that remove hooks and agents.
 * @returns The subject. The caller must call its `dispose`.
 * @throws {UsageError} When the spec cannot be found, has an unknown or contradictory option, is a folder with no skill
 *   and no plugin manifest, leaves no skill under a `skills` option, or holds a link that leads outside it.
 */
export function resolveSubject(
  label: Label,
  given: string,
  scope: SubjectScope,
): Subject {
  const flag = flagOf(label, given, scope.named ?? false);
  const { spec, options, text } = parseSpec(given, scope.cwd);
  if (spec === "none") {
    if (text !== "") {
      throw new UsageError(
        `${flag}: "none" loads nothing, so it takes no options`,
      );
    }
    return baseline(label);
  }
  const source = locate(flag, spec, scope);
  requireStrippable({ options, flag, strippers: scope.strippers });
  const left = globsFor(
    { flag, root: source.dir, project: scope.root },
    scope.left ?? NO_EXCLUSIONS,
  );
  const ownName = path.basename(source.dir);
  let stripped: Stripped = { agents: [], skills: [] };
  const shape = {
    globs: left,
    modify: (dir: string): void => {
      stripped = applyOptions(dir, {
        ...{ options, flag, strippers: scope.strippers },
        ...{ ownName, shown: source.dir },
      });
    },
  };
  const exported = exportNamed(
    flag,
    { ...source, repoRoot: scope.root },
    shape,
  );
  try {
    return {
      ...contentOf(exported.dir, { source, flag, ownName, spec }),
      ...{ label, spec, options: text, rulesOption: options.rules ?? null },
      ...{ commit: source.commit, exported: exported.dir, stripped },
      exportChanged: exported.changed,
      rules: rulesUnder(options.rules, {
        config: scope.rules ?? {},
        root: exported.dir,
        flag,
      }),
      sourceChanges: watchSource(source, left),
      revision: hashTree(exported.dir),
      dispose: exported.dispose,
    };
  } catch (error) {
    exported.dispose();
    throw error;
  }
}

/**
 * Reads what an export holds: its skills, and whether it is a plugin.
 * @param root - The export.
 * @param named - Where it came from.
 * @param named.source - The located source; a skill's path is told as it is in the source.
 * @param named.flag - How the user named the subject.
 * @param named.ownName - The skill name of the export's own SKILL.md, the project folder's name.
 * @param named.spec - What the user named, for the message.
 * @returns The kind, the skills with their directories in the source, and the plugin's own name.
 * @throws {UsageError} For a folder that is no plugin and holds no skill.
 */
function contentOf(
  root: string,
  named: { source: Located; flag: string; ownName: string; spec: string },
): Pick<Subject, "kind" | "dir" | "skills" | "skillDirs" | "pluginName"> {
  const { source, ownName } = named;
  const found = findSkills(root, ownName, source.dir);
  const skillDirs = Object.fromEntries(
    Object.entries(found).map(([name, dir]) => [
      name,
      path.join(source.dir, path.relative(root, dir)),
    ]),
  );
  const kind = isPlugin(root) ? "plugin" : "skills";
  if (kind === "skills" && Object.keys(skillDirs).length === 0) {
    throw new UsageError(
      `${named.flag}: no skills found in ${named.spec}; it needs <name>/SKILL.md, skills/<name>/SKILL.md, its own SKILL.md, or a plugin manifest`,
    );
  }
  return {
    kind,
    dir: source.dir,
    skills: Object.keys(skillDirs),
    skillDirs,
    pluginName: kind === "plugin" ? pluginNameOf(root) : null,
  };
}

/**
 * Hashes the source directory of a subject now, for a comparison at the end of the command.
 * @param source - Where the subject's files are.
 * @param globs - What the export leaves out, which the hash leaves out too.
 * @returns A function that hashes the directory again and lists what differs, sorted, as relative posix paths. For a
 *   git ref, whose commit cannot change, it lists nothing.
 */
function watchSource(source: Located, globs: string[]): () => string[] {
  if (source.commit) return () => [];
  const left = leaveOut(globs);
  const before = snapshot(source.dir, left);
  return () =>
    allChanged(diffSnapshots(before, snapshot(source.dir, left))).sort();
}

/**
 * Words the hard error for a subject directory that changed during the command.
 * @param paths - The changed paths, as the user would type them.
 * @returns The message, without the program's name.
 */
export const sourceChangedMessage = (paths: string[]): string =>
  `the subject directory changed during the run: ${paths.join(", ")}`;

/**
 * Finds what changed in the source directories of subjects since they were resolved.
 * @param subjects - The subjects of a command, after its last run.
 * @returns The changed paths, each as the user would type it: the subject as named, then the path inside it.
 */
export const changedAtSource = (subjects: Subject[]): string[] =>
  subjects.flatMap((subject) =>
    subject.sourceChanges().map((changed) => path.join(subject.spec, changed)),
  );

const KINDS = { plugin: "plugin", skills: "skills folder" };
const SHORT_HASH_LENGTH = 7;

/**
 * Says in one phrase what a subject is and where it came from, for the head of a report.
 * @param subject - A subject or its summary.
 * @returns For a git ref, the ref and its short commit hash. For a directory, its path.
 */
export function describeSubject(subject: SubjectSummary): string {
  if (!hasContent(subject)) return "no skills";
  const options = subject.options ? `, with ${subject.options}` : "";
  const source = subject.commit
    ? `\`${subject.spec}\` at ${subject.commit.slice(0, SHORT_HASH_LENGTH)}`
    : `directory \`${subject.dir}\` as it is on disk`;
  return `${KINDS[subject.kind]}, ${source}${options}`;
}
