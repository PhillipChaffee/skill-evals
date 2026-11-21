import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { UsageError, onDispose, tempDir } from "./scope.mjs";

/**
 * What a run loads into the harness. A comparison has the labels "a" and "b"; a single one is "subject".
 * @typedef {{ label: "a" | "b" | "subject", spec: string, kind: "plugin" | "skills" | "none", dir: string | null,
 *   skills: string[], skillDirs: Record<string, string>, commit: string | null, dispose: () => void }} Subject
 *   kind: "plugin" is a directory with a harness's plugin packaging, loaded the way that harness loads a local plugin;
 *     "skills" is a plain folder of skills, copied to where each harness discovers skills; "none" loads nothing
 *   skills: the names of the skills found in dir, sorted; skillDirs maps each to its directory
 *   commit is set when spec is a git ref; dir is then a detached worktree that dispose removes
 */

const PLUGIN_MARKERS = [".claude-plugin/plugin.json", ".cursor-plugin/plugin.json", ".codex-plugin/plugin.json", "plugin.json", ".opencode/plugins"];

function isPlugin(dir) {
	if (PLUGIN_MARKERS.some((marker) => fs.existsSync(path.join(dir, marker)))) return true;
	try {
		return "pi" in JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
	} catch {
		return false;
	}
}

const hasSkillFile = (dir) => fs.existsSync(path.join(dir, "SKILL.md"));

/**
 * Every `<dir>/<name>/SKILL.md` and `<dir>/skills/<name>/SKILL.md`, and dir itself when it holds a SKILL.md.
 * @param {string} ownName  the skill name of dir itself
 * @returns {Record<string, string>} skill name -> its directory, in name order
 */
function findSkills(dir, ownName) {
	const found = hasSkillFile(dir) ? [[ownName, dir]] : [];
	for (const parent of [dir, path.join(dir, "skills")]) {
		if (!fs.existsSync(parent)) continue;
		for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
			const skillDir = path.join(parent, entry.name);
			if (entry.isDirectory() && hasSkillFile(skillDir)) found.push([entry.name, skillDir]);
		}
	}
	const names = found.map(([name]) => name);
	const twice = names.find((name, index) => names.indexOf(name) !== index);
	if (twice) throw new UsageError(`${dir} holds two skills named "${twice}"`);
	return Object.fromEntries(found.sort(([x], [y]) => x.localeCompare(y)));
}

const git = (repoDir, ...args) =>
	execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A directory is used as it is. Anything else must be a git ref of the project, checked out into a detached worktree. */
function checkout(label, spec, project) {
	const dir = path.resolve(project.cwd, spec);
	if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return { dir: fs.realpathSync(dir), commit: null, dispose: () => {} };
	if (!project.isGitRepo) {
		throw new UsageError(`--${label} ${spec}: not a directory, and it cannot be a git ref because ${project.root} is not in a git repository`);
	}
	let commit;
	try {
		commit = git(project.root, "rev-parse", "--verify", "--quiet", `${spec}^{commit}`);
	} catch {
		throw new UsageError(`--${label} ${spec}: not a directory and not a git ref of ${project.root}`);
	}
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
 * `none`, a directory (used as it is, uncommitted changes included), or a git ref of the project.
 * @param {import("./project.mjs").Project} project
 * @returns {Subject}
 */
export function resolveSubject(label, spec, project) {
	if (spec === "none") return { label, spec, kind: "none", dir: null, skills: [], skillDirs: {}, commit: null, dispose: () => {} };
	const source = checkout(label, spec, project);
	try {
		// A worktree has a random name, so a ref's own skill takes the name of the project folder it was checked out from.
		const skillDirs = findSkills(source.dir, path.basename(source.commit ? project.root : source.dir));
		const kind = isPlugin(source.dir) ? "plugin" : "skills";
		if (kind === "skills" && Object.keys(skillDirs).length === 0) {
			throw new UsageError(
				`--${label} ${spec}: no skills found in ${spec}; it needs <name>/SKILL.md, skills/<name>/SKILL.md, its own SKILL.md, or a plugin manifest`,
			);
		}
		return { label, spec, kind, skills: Object.keys(skillDirs), skillDirs, ...source };
	} catch (error) {
		source.dispose();
		throw error;
	}
}

const KINDS = { plugin: "plugin", skills: "skills folder" };

export function describeSubject(subject) {
	if (subject.kind === "none") return "no skills";
	const source = subject.commit ? `\`${subject.spec}\` at ${subject.commit.slice(0, 7)}` : `directory \`${subject.dir}\` as it is on disk`;
	return `${KINDS[subject.kind]}, ${source}`;
}
