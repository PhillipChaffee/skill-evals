import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Project } from "./project.js";
import { UsageError, onDispose, tempDir } from "./scope.js";

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
  /** Null for "none". For a git ref it is a detached worktree. */
  dir: string | null;
  /** The names of the skills found in dir, sorted. */
  skills: string[];
  /** Set when spec is a git ref. */
  commit: string | null;
}

/** What a run loads into the harness. */
export interface Subject extends SubjectSummary {
  /** Skill name to its directory. */
  skillDirs: Record<string, string>;
  /** Removes the worktree of a git ref; does nothing for any other subject. */
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
 * @returns Skill name to its directory, in name order.
 * @throws {UsageError} When two skills share a name.
 */
function findSkills(dir: string, ownName: string): Record<string, string> {
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
  if (twice) throw new UsageError(`${dir} holds two skills named "${twice}"`);
  return Object.fromEntries(found.sort(([x], [y]) => x.localeCompare(y)));
}

const git = (repoDir: string, ...args: string[]): string =>
  execFileSync("git", ["-C", repoDir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/** Where a subject's files are, and how to let go of them. */
interface Source {
  dir: string;
  commit: string | null;
  dispose: () => void;
}

/**
 * Checks a git ref out into a detached worktree in a temp directory.
 * @param project - The repository that owns the ref.
 * @param commit - The full hash to check out.
 * @returns The worktree, and a `dispose` that removes it and its registration in the repository.
 */
function worktree(project: Project, commit: string): Source {
  const temp = tempDir("kit-");
  const dispose = onDispose(() => {
    try {
      git(project.root, "worktree", "remove", "--force", temp.dir);
    } catch {
      // Already removed, or never registered because the add below failed.
    }
    temp.dispose();
  });
  try {
    git(project.root, "worktree", "add", "--detach", temp.dir, commit);
  } catch (error) {
    dispose();
    throw error;
  }
  return { dir: temp.dir, commit, dispose };
}

/**
 * Locates the files of a subject. A directory is used as it is. Anything else must be a git ref of the project.
 * @param label - Names the flag in an error message.
 * @param spec - A directory, relative to the working directory, or a git ref.
 * @param project - Where a ref is looked up.
 * @returns The directory to load from.
 * @throws {UsageError} When spec is neither a directory nor a ref of the project.
 */
function checkout(label: Label, spec: string, project: Project): Source {
  const dir = path.resolve(project.cwd, spec);
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
    return {
      dir: fs.realpathSync(dir),
      commit: null,
      dispose: () => undefined,
    };
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
  return worktree(project, commit);
}

/**
 * Turns what the user named into something a harness can load.
 * @param label - The subject's place in the comparison.
 * @param spec - `none`, a directory (used as it is, uncommitted changes included), or a git ref of the project.
 * @param project - What a relative directory and a ref resolve against.
 * @returns The subject. The caller must call its `dispose`.
 * @throws {UsageError} When spec cannot be found, or is a folder with no skill and no plugin manifest.
 */
export function resolveSubject(
  label: Label,
  spec: string,
  project: Project,
): Subject {
  if (spec === "none") {
    return {
      label,
      spec,
      kind: "none",
      dir: null,
      skills: [],
      skillDirs: {},
      commit: null,
      dispose: () => undefined,
    };
  }
  const source = checkout(label, spec, project);
  try {
    // A worktree has a random name, so a ref's own skill takes the name of the project folder it was checked out from.
    const skillDirs = findSkills(
      source.dir,
      path.basename(source.commit ? project.root : source.dir),
    );
    const kind = isPlugin(source.dir) ? "plugin" : "skills";
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
      dispose: source.dispose,
    };
  } catch (error) {
    source.dispose();
    throw error;
  }
}

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
