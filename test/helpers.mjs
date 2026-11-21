import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const repoDir = path.resolve(import.meta.dirname, "..");
const bin = path.join(repoDir, "bin/skill-evals.mjs");
export const fakeHarness = path.join(import.meta.dirname, "fixtures/fake-harness.mjs");

/** A temp directory with a `cli` that sees no installed harness but the fake one, behind the Claude Code adapter. */
export function sandbox(t) {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "runs-")));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const write = (relative, content) => {
		const file = path.join(root, relative);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
		return file;
	};
	// A PATH that holds node and git and nothing else, so no harness installed on this machine can be picked up.
	fs.mkdirSync(path.join(root, "bin"));
	fs.symlinkSync(process.execPath, path.join(root, "bin/node"));
	fs.symlinkSync(execFileSync("which", ["git"], { encoding: "utf8" }).trim(), path.join(root, "bin/git"));
	const cli = (args, env = {}, cwd = root) =>
		spawnSync(process.execPath, [bin, ...args], {
			cwd,
			encoding: "utf8",
			env: { PATH: path.join(root, "bin"), HOME: root, SKILL_EVALS_BIN_CLAUDE_CODE: fakeHarness, ...env },
		});
	return { root, write, cli };
}


/** Makes dir a git repository with one commit on the branch `trunk`, and returns a `git` bound to it. */
export function gitRepo(dir) {
	const git = (...args) =>
		execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
			encoding: "utf8",
		}).trim();
	git("init", "-q", "-b", "trunk");
	git("commit", "-q", "--allow-empty", "-m", "start");
	return git;
}
