import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { UsageError, onDispose, tempDir } from "./scope.mjs";

/**
 * One version of the kit: a checkout. A comparison has "a" and "b"; a single version is "kit".
 * @typedef {{ label: "a" | "b" | "kit", spec: string, dir: string, commit: string | null, dispose: () => void }} Variant
 *   commit is set when spec is a git ref; dir is then a detached worktree that dispose removes
 */

const git = (repoDir, ...args) =>
	execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/**
 * A directory is used as it is, uncommitted changes included. Anything else must be a git ref of repoDir.
 * @returns {Variant}
 */
export function resolveVariant(label, spec, repoDir) {
	if (fs.existsSync(spec) && fs.statSync(spec).isDirectory()) {
		return { label, spec, dir: fs.realpathSync(spec), commit: null, dispose: () => {} };
	}
	let commit;
	try {
		commit = git(repoDir, "rev-parse", "--verify", "--quiet", `${spec}^{commit}`);
	} catch {
		throw new UsageError(`--${label} ${spec}: not a directory and not a git ref of ${repoDir}`);
	}
	const temp = tempDir("kit-");
	const dispose = onDispose(() => {
		try {
			git(repoDir, "worktree", "remove", "--force", temp.dir);
		} catch {
			// Already removed, or never registered because the add below failed.
		}
		temp.dispose();
	});
	try {
		git(repoDir, "worktree", "add", "--detach", temp.dir, commit);
	} catch (error) {
		dispose();
		throw error;
	}
	return { label, spec, dir: temp.dir, commit, dispose };
}

export const describeVariant = (variant) =>
	variant.commit ? `\`${variant.spec}\` at ${variant.commit.slice(0, 7)}` : `directory \`${variant.dir}\` as it is on disk`;
