import fs from "node:fs";
import path from "node:path";
import { TOOL_KINDS } from "./harnesses/shared.mjs";
import { isUnitScore } from "./score.mjs";
import { UsageError } from "./scope.mjs";

/**
 * @typedef {{ type: string, weight: number, skill?: string, pattern?: string, text?: string, path?: string,
 *   kind?: import("./harnesses/shared.mjs").ToolKind, name?: string, inputMatches?: string, flags?: string,
 *   rubric?: string }} Check  the fields a type takes are in CHECKS
 * @typedef {{ id: string, prompt: string, checks: Check[], weight: number, minScore?: number, maxTurns?: number,
 *   timeoutSeconds: number, workspaceDir: string | null }} Case
 * @typedef {{ finalText: string, toolCalls: import("./harnesses/shared.mjs").ToolCall[], skillsLoaded: string[],
 *   workspace: string }} Outcome  what a deterministic check can observe
 */

const DEFAULT_TIMEOUT_SECONDS = 600;
const REGEX_FIELDS = ["pattern", "name", "inputMatches"];

const regex = (check, field = "pattern") => new RegExp(check[field], check.flags ?? "");

function fileText(check, outcome) {
	try {
		return fs.readFileSync(path.join(outcome.workspace, check.path), "utf8");
	} catch {
		return null;
	}
}

const toolCalled = (check, outcome) =>
	outcome.toolCalls.some(
		(call) =>
			(check.kind === undefined || call.kind === check.kind) &&
			(check.name === undefined || regex(check, "name").test(call.name)) &&
			(check.inputMatches === undefined || regex(check, "inputMatches").test(JSON.stringify(call.input ?? null))),
	);

const holds = (fields, test, more = {}) => ({ fields, ...more, rule: (check, outcome) => Number(test(check, outcome)) });
const fails = (fields, test, more) => holds(fields, (check, outcome) => !test(check, outcome), more);
const TOOL_FIELDS = { optional: ["kind", "name", "inputMatches", "flags"], oneOf: ["kind", "name"] };
const skillLoaded = (check, outcome) => outcome.skillsLoaded.includes(check.skill);
const outputMatches = (check, outcome) => regex(check).test(outcome.finalText);
const outputContains = (check, outcome) => outcome.finalText.includes(check.text);

/**
 * Check type -> the fields it requires, the fields it may take, and the rule that scores it from 0 to 1.
 * A type with no rule is scored by a model instead (see judge.mjs).
 */
const CHECKS = {
	skill_loaded: holds(["skill"], skillLoaded),
	skill_not_loaded: fails(["skill"], skillLoaded),
	output_matches: holds(["pattern"], outputMatches, { optional: ["flags"] }),
	output_lacks: fails(["pattern"], outputMatches, { optional: ["flags"] }),
	output_contains: holds(["text"], outputContains),
	output_not_contains: fails(["text"], outputContains),
	file_exists: holds(["path"], (check, outcome) => fileText(check, outcome) !== null),
	file_matches: holds(
		["path", "pattern"],
		(check, outcome) => {
			const text = fileText(check, outcome);
			return text !== null && regex(check).test(text);
		},
		{ optional: ["flags"] },
	),
	tool_called: holds([], toolCalled, TOOL_FIELDS),
	tool_not_called: fails([], toolCalled, TOOL_FIELDS),
	judge: { fields: ["rubric"] },
};

export const isJudged = (check) => !CHECKS[check.type].rule;

/** @returns {number} the score of a deterministic check: 0 or 1 */
export const checkScore = (check, outcome) => CHECKS[check.type].rule(check, outcome);

export function describeCheck(check) {
	const quoted = [check.text, check.rubric]
		.filter(Boolean)
		.map((text) => JSON.stringify(text.length > 60 ? `${text.slice(0, 57)}...` : text));
	const patterns = REGEX_FIELDS.filter((field) => check[field] !== undefined).map((field) => `/${check[field]}/${check.flags ?? ""}`);
	const weight = check.weight === 1 ? [] : [`(weight ${check.weight})`];
	return [check.type, check.skill, check.path, check.kind, ...quoted, ...patterns, ...weight].filter(Boolean).join(" ");
}

function weightOf(raw, where) {
	const weight = raw.weight ?? 1;
	if (!(Number.isFinite(weight) && weight > 0)) throw new UsageError(`${where}: weight must be a positive number`);
	return weight;
}

function parseCheck(raw, where) {
	const kind = Object.hasOwn(CHECKS, raw?.type ?? "") && CHECKS[raw.type];
	if (!kind) {
		throw new UsageError(`${where}: unknown check type ${JSON.stringify(raw?.type)}; known: ${Object.keys(CHECKS).join(", ")}`);
	}
	const check = { type: raw.type, weight: weightOf(raw, where) };
	const fields = [...kind.fields, ...(kind.optional ?? []).filter((field) => raw[field] !== undefined)];
	for (const field of fields) {
		if (typeof raw[field] !== "string" || raw[field] === "") {
			throw new UsageError(`${where}: ${raw.type} needs a string "${field}"`);
		}
		check[field] = raw[field];
	}
	if (kind.oneOf && !kind.oneOf.some((field) => check[field] !== undefined)) {
		throw new UsageError(`${where}: ${raw.type} needs at least one of ${kind.oneOf.map((field) => `"${field}"`).join(", ")}`);
	}
	if (check.kind !== undefined && !TOOL_KINDS.includes(check.kind)) {
		throw new UsageError(`${where}: unknown tool kind "${check.kind}"; known: ${TOOL_KINDS.join(", ")}`);
	}
	try {
		for (const field of REGEX_FIELDS) if (check[field] !== undefined) regex(check, field);
	} catch (error) {
		throw new UsageError(`${where}: ${error.message}`);
	}
	if (check.path !== undefined && (path.isAbsolute(check.path) || check.path.split(/[\\/]/).includes(".."))) {
		throw new UsageError(`${where}: path must stay inside the workspace: ${check.path}`);
	}
	return check;
}

const positive = (value, where, name) => {
	if (value !== undefined && !(Number.isInteger(value) && value > 0)) {
		throw new UsageError(`${where}: ${name} must be a positive integer`);
	}
	return value;
};

/** @returns {Case} */
function loadCase(dir) {
	const id = path.basename(dir);
	const file = path.join(dir, "case.json");
	let prompt;
	let raw;
	try {
		prompt = fs.readFileSync(path.join(dir, "prompt.md"), "utf8").trim();
		raw = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (error) {
		throw new UsageError(`case ${id}: ${error.message}`);
	}
	if (!prompt) throw new UsageError(`case ${id}: prompt.md is empty`);
	if (!Array.isArray(raw?.checks) || raw.checks.length === 0) throw new UsageError(`${file}: "checks" must be a non-empty array`);
	if (raw.minScore !== undefined && !isUnitScore(raw.minScore)) throw new UsageError(`${file}: minScore must be a number from 0 to 1`);
	const workspaceDir = path.join(dir, "workspace");
	return {
		id,
		prompt,
		checks: raw.checks.map((check, index) => parseCheck(check, `${file} checks[${index}]`)),
		weight: weightOf(raw, file),
		minScore: raw.minScore,
		maxTurns: positive(raw.maxTurns, file, "maxTurns"),
		timeoutSeconds: positive(raw.timeoutSeconds, file, "timeoutSeconds") ?? DEFAULT_TIMEOUT_SECONDS,
		workspaceDir: fs.existsSync(workspaceDir) ? workspaceDir : null,
	};
}

/** Every case under casesDir whose id matches the glob (only `*` is special), sorted by id. */
export function loadCases(casesDir, glob = "*") {
	const literal = (part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
	const matcher = new RegExp(`^${glob.split("*").map(literal).join(".*")}$`);
	let entries;
	try {
		entries = fs.readdirSync(casesDir, { withFileTypes: true });
	} catch (error) {
		throw new UsageError(`cannot read the cases directory ${casesDir} (${error.code}); create it or pass --cases`);
	}
	const cases = entries
		.filter((entry) => entry.isDirectory() && matcher.test(entry.name))
		.map((entry) => loadCase(path.join(casesDir, entry.name)))
		.sort((x, y) => x.id.localeCompare(y.id));
	if (cases.length === 0) throw new UsageError(`no case in ${casesDir} matches "${glob}"`);
	return cases;
}
