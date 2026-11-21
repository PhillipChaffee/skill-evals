import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sumTokens } from "./harnesses/shared.mjs";
import { checkScore, isJudged } from "./cases.mjs";
import { judge } from "./judge.mjs";
import { weightedMean } from "./score.mjs";
import { onDispose, tempDir } from "./scope.mjs";

/**
 * @typedef {{ durationMs: number, tokens: import("./harnesses/shared.mjs").Tokens | null, costUsd: number | null }} Usage
 * @typedef {import("./cases.mjs").Check & { score: number | null, reason?: string }} CheckResult
 *   score is null when a judged check got no usable answer; reason is the judge's, or why there is no score
 * @typedef {{ harness: string, subject: string, caseId: string, rep: number, ok: boolean, error: string | null,
 *   finalText: string, toolCalls: import("./harnesses/shared.mjs").ToolCall[], skillsLoaded: string[],
 *   subjectLoaded: boolean | null, checks: CheckResult[], score: number | null,
 *   judge: (Usage & { calls: number }) | null } & Usage} RunRecord
 *   subject: the subject's label
 *   subjectLoaded: whether the harness reported the subject as loaded at startup; null when it reports nothing,
 *     or when there is nothing to load
 *   score: the run score, null when the run is invalid
 *   judge: what the judged checks cost, kept apart from the run's own numbers; null when no judge ran
 * @typedef {{ harness: import("./harnesses/shared.mjs").Harness, bin: string, model?: string }} Judge
 */

// A judge answers in one message. The second turn is room for one stray tool call before the answer.
const JUDGE_LIMITS = { maxTurns: 2, timeoutSeconds: 300 };
const SKILL_FILE = /skills[\\/]+([\w-]+)[\\/]+skill\.md/gi;

/**
 * The one rule for "the agent loaded a skill", shared by every harness: a call of the harness's skill tool that names
 * it (any `plugin:` prefix dropped), or any tool call whose input points at `skills/<name>/SKILL.md`.
 * @param {import("./harnesses/shared.mjs").ToolCall[]} toolCalls
 */
export function skillsLoaded(toolCalls) {
	const names = new Set();
	for (const { kind, input } of toolCalls) {
		if (kind === "skill") {
			const named = [input?.skill, input?.name, input?.id].find((value) => typeof value === "string");
			if (named) names.add(named.split(":").at(-1));
		}
		for (const match of JSON.stringify(input ?? null).matchAll(SKILL_FILE)) names.add(match[1]);
	}
	return [...names].sort();
}

/** Why a record must not be counted, or null when it is a valid run. */
export function invalidReason(record) {
	if (record.error) return `run failed: ${record.error}`;
	if (record.subjectLoaded === false) return "the harness did not load the subject: it is not among the plugins and skills it reported";
	const unscored = record.checks.find((check) => check.score === null);
	if (unscored) return `a judged check has no score: ${unscored.reason}`;
	return null;
}

function samePath(x, y) {
	const real = (p) => {
		try {
			return fs.realpathSync(p);
		} catch {
			return path.resolve(p);
		}
	};
	return real(x) === real(y);
}

/**
 * Subject kind -> whether the harness reported the subject as loaded, or null when it does not report that.
 * A plugin is found by its directory and a skills folder by the name of every skill in it.
 */
const REPORTED_LOADED = {
	plugin: (subject, loaded) => loaded.paths && loaded.paths.some((loadedPath) => samePath(loadedPath, subject.dir)),
	skills: (subject, loaded) => loaded.skills && subject.skills.every((name) => loaded.skills.includes(name)),
	none: () => null,
};

/** The child sees a throwaway home and nothing that names this tool. */
function childEnv(home, extra) {
	const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("SKILL_EVALS_")));
	return {
		...inherited,
		HOME: home,
		XDG_CONFIG_HOME: path.join(home, ".config"),
		XDG_DATA_HOME: path.join(home, ".local", "share"),
		XDG_STATE_HOME: path.join(home, ".local", "state"),
		XDG_CACHE_HOME: path.join(home, ".cache"),
		...extra,
	};
}

function copyAuthFiles(authFiles, home) {
	for (const relative of authFiles) {
		const source = path.join(os.homedir(), relative);
		if (!fs.existsSync(source)) continue;
		const target = path.join(home, relative);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.copyFileSync(source, target);
		fs.chmodSync(target, 0o600);
	}
}

/** @returns {Promise<{ stdout: string, failure: string | null }>} */
function exec(bin, args, { cwd, env, timeoutSeconds, stdin }) {
	return new Promise((resolve) => {
		// Its own process group, so a timeout or an interrupt also stops whatever the harness started.
		const child = spawn(bin, args, { cwd, env, stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"], detached: true });
		// A harness that exits without reading its input must not take this process down with EPIPE.
		child.stdin?.on("error", () => {});
		child.stdin?.end(stdin);
		const kill = () => {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				// The group already exited.
			}
		};
		// Runs when the child closes too, so nothing the harness left in the background outlives the run.
		const reap = onDispose(kill);
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		const timer = setTimeout(() => {
			timedOut = true;
			kill();
		}, timeoutSeconds * 1000);
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		const finish = (failure) => {
			clearTimeout(timer);
			reap();
			resolve({ stdout, failure });
		};
		child.on("error", (error) => finish(error.message));
		child.on("close", (code, signal) => {
			if (timedOut) finish(`timed out after ${timeoutSeconds} s`);
			else finish(code === 0 ? null : `exit ${code ?? signal}: ${stderr.trim().slice(-400)}`);
		});
	});
}

async function attempt(harness, bin, input, timeoutSeconds) {
	let invocation;
	try {
		invocation = harness.invocation(input);
	} catch (error) {
		return { stdout: "", failure: `could not prepare the run: ${error.message}`, durationMs: 0 };
	}
	const options = { cwd: input.workspace, env: childEnv(input.home, invocation.env), timeoutSeconds };
	for (const step of invocation.setup ?? []) {
		const { failure } = await exec(bin, step, options);
		if (failure) return { stdout: "", failure: `setup "${step.slice(0, 2).join(" ")}": ${failure}`, durationMs: 0 };
	}
	const started = Date.now();
	const result = await exec(bin, invocation.args, { ...options, stdin: invocation.stdin });
	return { ...result, durationMs: Date.now() - started };
}

/**
 * One prompt in one harness, in a fresh home and workspace. `use` sees the result while the workspace still exists.
 * @template T
 * @param {{ harness: import("./harnesses/shared.mjs").Harness, bin: string,
 *   subject: import("./harnesses/shared.mjs").LoadedSubject | null, prompt: string, model?: string, maxTurns?: number,
 *   timeoutSeconds: number, workspaceDir?: string | null }} run
 * @param {(result: { stdout: string, parsed: import("./harnesses/shared.mjs").Parsed, error: string | null,
 *   durationMs: number, workspace: string }) => T} use
 */
async function session({ harness, bin, subject, prompt, model, maxTurns, timeoutSeconds, workspaceDir }, use) {
	const home = tempDir("home-");
	const workspace = tempDir("proj-");
	try {
		if (workspaceDir) fs.cpSync(workspaceDir, workspace.dir, { recursive: true });
		copyAuthFiles(harness.authFiles, home.dir);
		const input = { subject, home: home.dir, workspace: workspace.dir, prompt, model, maxTurns };
		const { stdout, failure, durationMs } = await attempt(harness, bin, input, timeoutSeconds);
		const parsed = harness.parse(stdout);
		// The harness's own message is the most specific one, but only when it produced a stream at all.
		const error = (stdout.trim() && parsed.error) || failure || parsed.error || null;
		return await use({ stdout, parsed, error, durationMs, workspace: workspace.dir });
	} finally {
		home.dispose();
		workspace.dispose();
	}
}

/** @returns {Usage & { calls: number }} a number no reply reports stays null */
function totalUsage(replies) {
	const costs = replies.map((reply) => reply.costUsd);
	return {
		calls: replies.length,
		durationMs: replies.reduce((total, reply) => total + reply.durationMs, 0),
		tokens: sumTokens(replies.map((reply) => reply.tokens).filter(Boolean)),
		costUsd: costs.includes(null) ? null : costs.reduce((total, cost) => total + cost, 0),
	};
}

/**
 * One prompt, one harness, one subject: run, normalize, score every check, clean up.
 * The judge runs with nothing loaded, and its prompt carries nothing about the subject.
 * @param {{ harness: import("./harnesses/shared.mjs").Harness, bin: string, subject: import("./subject.mjs").Subject,
 *   caseDef: import("./cases.mjs").Case, rep: number, model?: string, judge?: Judge, outDir: string }} run
 * @returns {Promise<RunRecord>}
 */
export async function runOnce({ harness, bin, subject, caseDef, rep, model, judge: judgeWith, outDir }) {
	const { prompt, maxTurns, timeoutSeconds, workspaceDir } = caseDef;
	// To a harness, no skills and the judge's "nothing loaded" are the same thing.
	const toLoad = subject.kind === "none" ? null : subject;
	return session({ harness, bin, subject: toLoad, prompt, model, maxTurns, timeoutSeconds, workspaceDir }, async (ran) => {
		const { stdout, parsed, error, durationMs } = ran;
		const outcome = { ...parsed, skillsLoaded: skillsLoaded(parsed.toolCalls), workspace: ran.workspace };

		const stem = path.join(outDir, harness.id, caseDef.id, `${subject.label}${rep}`);
		fs.mkdirSync(path.dirname(stem), { recursive: true });
		fs.writeFileSync(`${stem}.stream.jsonl`, stdout);
		fs.writeFileSync(`${stem}.final.md`, parsed.finalText);

		const record = {
			harness: harness.id,
			subject: subject.label,
			caseId: caseDef.id,
			rep,
			ok: !error,
			error,
			finalText: parsed.finalText,
			toolCalls: parsed.toolCalls,
			skillsLoaded: outcome.skillsLoaded,
			subjectLoaded: REPORTED_LOADED[subject.kind](subject, parsed.loaded),
			durationMs,
			tokens: parsed.tokens,
			costUsd: parsed.costUsd,
			checks: [],
		};
		const judgeable = invalidReason(record) === null;
		const ask = (judgePrompt) =>
			session(
				{ ...judgeWith, subject: null, prompt: judgePrompt, ...JUDGE_LIMITS },
				({ parsed: reply, error: failure, durationMs: took }) => ({
					finalText: reply.finalText,
					error: failure,
					durationMs: took,
					tokens: reply.tokens,
					costUsd: reply.costUsd,
				}),
			);
		const replies = [];
		for (const check of caseDef.checks) {
			if (!isJudged(check)) {
				record.checks.push({ ...check, score: checkScore(check, outcome) });
			} else if (!judgeable) {
				record.checks.push({ ...check, score: null, reason: "not judged, because the run is invalid" });
			} else {
				const verdict = await judge(ask, { task: prompt, answer: parsed.finalText, rubric: check.rubric });
				replies.push(...verdict.replies);
				record.checks.push({ ...check, score: verdict.score, reason: verdict.reason });
			}
		}
		return {
			...record,
			score: invalidReason(record) ? null : weightedMean(record.checks),
			judge: replies.length ? totalUsage(replies) : null,
		};
	});
}
