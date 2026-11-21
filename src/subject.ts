import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { NO_EXCLUSIONS, globsFor } from "./exclusions.js";
import type { Exclusions } from "./exclusions.js";
import { exportSubject, leaveOut } from "./isolate.js";
import type { Project } from "./project.js";
import { UsageError } from "./scope.js";
import { allChanged, diffSnapshots, snapshot } from "./snapshot.js";

/** A comparison has the labels "a" and "b"; a single subject is "subject". */
export type Label = "a" | "b" | "subject";

/** The part of a subject that goes into `results.json` and the report. */
export interface SubjectSummary {
  label: Label;
  /** What the user named: "none", a directory, or a git ref of the project. */
  spec: string;
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
  /** The export that every run copies; null for "none". It has left out what the subject excludes. */
  exported: string | null;
  /** Lists what a run edited in the export, which would reach later runs; none unless one did. */
  exportChanged: () => string[];
  /** The paths of the source directory that changed since the subject was resolved; none for a git ref and "none". */
  sourceChanges: () => string[];
  /** Removes the export. */
  dispose: () => void;
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

const hasSkillFile = (dir: string): boolean =>
  fs.existsSync(path.join(dir, "SKILL.md"));

/**
 * Finds every `<dir>/<name>/SKILL.md` and `<dir>/skills/<name>/SKILL.md`, and dir itself when it holds a SKILL.md.
 * @param dir - The folder to search, one level deep.
 * @param ownName - The skill name of dir itself.
 * @param shown - What an error message calls dir.
 * @returns Skill name to its directory, in name order.
 * @throws {UsageError} When two skills share a name.
 */
function findSkills(
  dir: string,
  ownName: string,
  shown: string,
): Record<string, string> {
  const found: [string, string][] = hasSkillFile(dir) ? [[ownName, dir]] : [];
  for (const parent of [dir, path.join(dir, "skills")]) {
    if (!fs.existsSync(parent)) continue;
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      const skillDir = path.join(parent, entry.name);
      if (entry.isDirectory() && hasSkillFile(skillDir)) {
        found.push([entry.name, skillDir]);
      }
    }
  }
  const names = found.map(([name]) => name);
  const twice = names.find((name, index) => names.indexOf(name) !== index);
  if (twice) throw new UsageError(`${shown} holds two skills named "${twice}"`);
  return Object.fromEntries(found.sort(([x], [y]) => x.localeCompare(y)));
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
 * @param label - Names the flag in an error message.
 * @param spec - A directory, relative to the working directory, or a git ref.
 * @param project - Where a ref is looked up.
 * @returns The directory, or the project and the commit of the ref.
 * @throws {UsageError} When spec is neither a directory nor a ref of the project.
 */
function locate(label: Label, spec: string, project: Project): Located {
  const dir = path.resolve(project.cwd, spec);
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
    return { dir: fs.realpathSync(dir), commit: null };
  }
  if (!project.isGitRepo) {
    throw new UsageError(
      `--${label} ${spec}: not a directory, and it cannot be a git ref because ${project.root} is not in a git repository`,
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
      `--${label} ${spec}: not a directory and not a git ref of ${project.root}`,
    );
  }
  return { dir: project.root, commit };
}

/** Where a command's subjects are looked up, and what their exports leave out. */
export interface SubjectScope extends Project {
  /** Default: nothing besides `.git` and `node_modules`. */
  left?: Exclusions;
}

/**
 * Exports a subject, and words a failure with the flag it came from.
 * @param flag - How the user named the subject, such as `--a main`, for the message.
 * @param source - Where the files are.
 * @param globs - What the export leaves out.
 * @returns The directory of the export and the `dispose` that removes it.
 * @throws {UsageError} When the export fails.
 */
function exportNamed(
  flag: string,
  source: Parameters<typeof exportSubject>[0],
  globs: string[],
): ReturnType<typeof exportSubject> {
  try {
    return exportSubject(source, globs);
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
  commit: null,
  exported: null,
  exportChanged: () => [],
  sourceChanges: () => [],
  dispose: () => undefined,
});

/**
 * Turns what the user named into something a harness can load. A subject is never loaded in place: it is exported
 * once, and each run loads its own copy of the export.
 * @param label - The subject's place in the comparison.
 * @param spec - `none`, a directory (as it is on disk, uncommitted changes included), or a git ref of the project.
 * @param scope - What a relative directory and a ref resolve against, and what the export leaves out besides `.git`
 *   and `node_modules`.
 * @returns The subject. The caller must call its `dispose`.
 * @throws {UsageError} When spec cannot be found, is a folder with no skill and no plugin manifest, or holds a link
 *   that leads outside it.
 */
export function resolveSubject(
  label: Label,
  spec: string,
  scope: SubjectScope,
): Subject {
  if (spec === "none") return baseline(label);
  const source = locate(label, spec, scope);
  const flag = `--${label} ${spec}`;
  const left = globsFor(
    { flag, root: source.dir, project: scope.root },
    scope.left ?? NO_EXCLUSIONS,
  );
  const exported = exportNamed(flag, { ...source, repoRoot: scope.root }, left);
  try {
    // A ref's own skill takes the name of the project folder it was exported from.
    const found = findSkills(
      exported.dir,
      path.basename(source.dir),
      source.dir,
    );
    const skillDirs = Object.fromEntries(
      Object.entries(found).map(([name, dir]) => [
        name,
        path.join(source.dir, path.relative(exported.dir, dir)),
      ]),
    );
    const kind = isPlugin(exported.dir) ? "plugin" : "skills";
    if (kind === "skills" && Object.keys(skillDirs).length === 0) {
      throw new UsageError(
        `--${label} ${spec}: no skills found in ${spec}; it needs <name>/SKILL.md, skills/<name>/SKILL.md, its own SKILL.md, or a plugin manifest`,
      );
    }
    return {
      label,
      spec,
      kind,
      dir: source.dir,
      skills: Object.keys(skillDirs),
      skillDirs,
      commit: source.commit,
      exported: exported.dir,
      exportChanged: exported.changed,
      sourceChanges: watchSource(source, left),
      dispose: exported.dispose,
    };
  } catch (error) {
    exported.dispose();
    throw error;
  }
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

/** The exit code of a command whose subject directory changed while it ran. A later task makes it 3. */
export const SUBJECT_CHANGED_EXIT_CODE = 1;

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
  const source = subject.commit
    ? `\`${subject.spec}\` at ${subject.commit.slice(0, SHORT_HASH_LENGTH)}`
    : `directory \`${subject.dir}\` as it is on disk`;
  return `${KINDS[subject.kind]}, ${source}`;
}
