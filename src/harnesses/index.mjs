import fs from "node:fs";
import path from "node:path";
import { UsageError } from "../scope.mjs";
import claudeCode from "./claude-code.mjs";
import codex from "./codex.mjs";
import cursor from "./cursor.mjs";
import opencode from "./opencode.mjs";
import pi from "./pi.mjs";

// Default-preference order: the first installed one runs when --harness is absent.
// Pi leads because it has the smallest install, the fastest start, and reports tokens and cost.
export const HARNESSES = [pi, claudeCode, cursor, opencode, codex];

const overrideVar = (harness) => `SKILL_EVALS_BIN_${harness.id.toUpperCase().replaceAll("-", "_")}`;

function isExecutable(file) {
	try {
		fs.accessSync(file, fs.constants.X_OK);
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

/** The executable to spawn for a harness, or null when it is not installed. */
export function findBin(harness, env = process.env) {
	const bin = env[overrideVar(harness)] || harness.bin;
	const candidates = bin.includes(path.sep)
		? [path.resolve(bin)]
		: (env.PATH ?? "")
				.split(path.delimiter)
				.filter(Boolean)
				.map((dir) => path.join(dir, bin));
	return candidates.find(isExecutable) ?? null;
}

function byId(id) {
	const harness = HARNESSES.find((h) => h.id === id);
	if (!harness) throw new UsageError(`unknown harness "${id}"; known: ${HARNESSES.map((h) => h.id).join(", ")}`);
	return harness;
}

/** Harnesses named by a comma-separated list; every known harness when the list is absent or "all". */
export function namedHarnesses(spec) {
	return !spec || spec === "all" ? HARNESSES : spec.split(",").map((id) => byId(id.trim()));
}

/**
 * The harnesses a run uses, each with its executable, and why they were chosen.
 * @returns {{ chosen: { harness: import("./shared.mjs").Harness, bin: string }[], reason: string }}
 */
export function selectHarnesses(spec, env = process.env) {
	const order = HARNESSES.map((h) => h.id).join(", ");
	const located = namedHarnesses(spec).map((harness) => ({ harness, bin: findBin(harness, env) }));
	const installed = located.filter((entry) => entry.bin);
	if (spec && spec !== "all") {
		const missing = located
			.filter((entry) => !entry.bin)
			.map(({ harness }) => `${harness.id} (no "${harness.bin}" on PATH; set ${overrideVar(harness)})`);
		if (missing.length) throw new UsageError(`harness not installed: ${missing.join("; ")}`);
		return { chosen: installed, reason: "named with --harness" };
	}
	if (installed.length === 0) throw new UsageError(`no harness is installed; looked for ${order}`);
	if (spec === "all") return { chosen: installed, reason: `every installed harness of ${order}` };
	return { chosen: [installed[0]], reason: `default, the first installed harness in the order ${order}` };
}
