import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { UsageError } from "./scope.mjs";

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

const CONFIG_FILE = "skill-evals.config.json";
// Config key -> the type of its value. Each key is the default of the option with the same name.
const CONFIG_KEYS = {
	cases: "string",
	harness: "string",
	reps: "number",
	model: "string",
	judgeHarness: "string",
	judgeModel: "string",
	minScore: "number",
};

/**
 * The project's optional config file. `cases` comes back as an absolute path, resolved against the project root.
 * @typedef {{ cases?: string, harness?: string, reps?: number, model?: string, judgeHarness?: string,
 *   judgeModel?: string, minScore?: number }} Config
 * @returns {Config} empty when the project has no config file
 */
export function loadConfig(root) {
	const file = path.join(root, CONFIG_FILE);
	if (!fs.existsSync(file)) return {};
	let config;
	try {
		config = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (error) {
		throw new UsageError(`${file}: ${error.message}`);
	}
	if (config === null || typeof config !== "object" || Array.isArray(config)) throw new UsageError(`${file}: must hold one JSON object`);
	for (const [key, value] of Object.entries(config)) {
		if (!Object.hasOwn(CONFIG_KEYS, key)) throw new UsageError(`${file}: unknown key "${key}"; known: ${Object.keys(CONFIG_KEYS).join(", ")}`);
		if (typeof value !== CONFIG_KEYS[key]) throw new UsageError(`${file}: "${key}" must be a ${CONFIG_KEYS[key]}`);
	}
	return config.cases === undefined ? config : { ...config, cases: path.resolve(root, config.cases) };
}

/**
 * The options a command works with: the built-in default for `cases`, then the config file, then every option that is set.
 * @template {{ cases?: string }} Options
 * @param {Project} project
 * @param {Options} options
 * @returns {Config & Options & { cases: string }}
 */
export function withConfig(project, options) {
	const set = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
	if (set.cases !== undefined) set.cases = path.resolve(project.cwd, set.cases);
	return { cases: path.join(project.root, "evals", "cases"), ...loadConfig(project.root), ...set };
}
