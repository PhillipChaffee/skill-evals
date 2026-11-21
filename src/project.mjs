import { execFileSync } from "node:child_process";
import fs from "node:fs";

/**
 * The project a command works on: the git top level of the working directory, or the working directory itself
 * when it is not in a git repository. Relative paths on a command line resolve against cwd.
 * @typedef {{ root: string, isGitRepo: boolean, cwd: string }} Project
 * @returns {Project}
 */
export function findProject(cwd) {
	try {
		const root = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		return { root: root.trim(), isGitRepo: true, cwd };
	} catch {
		return { root: fs.realpathSync(cwd), isGitRepo: false, cwd };
	}
}
