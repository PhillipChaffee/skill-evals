import fs from "node:fs";
import path from "node:path";
import { globToRegExp } from "./glob.js";
import { UsageError } from "./scope.js";

/** What the options of a subject spec ask of the subject's export. Each is absent when the spec does not give it. */
export interface SubjectOptions {
  /** `hooks=off`: the export has no hook configuration. */
  hooks?: "off";
  /** `rules=on` installs the subject's rules; `rules=off` installs none. Absent: the configured behaviour. */
  rules?: "on" | "off";
  /**
   * `agents=off` removes every agent definition; `agents=except:<glob>` removes those whose name matches the glob, and
   * `agents=only:<glob>` removes those whose name does not.
   */
  agents?: "off" | { except: string } | { only: string };
  /** `skills=only:<glob>` keeps the skills whose name matches; `skills=except:<glob>` removes those that match. */
  skills?: { mode: "only" | "except"; glob: string };
}

/** The names of what an export lost to the options of its spec. */
export interface Stripped {
  agents: string[];
  skills: string[];
}

/** A spec as the user typed it, taken apart. */
export interface ParsedSpec {
  /** What names the subject: `none`, a directory or a git ref. */
  spec: string;
  options: SubjectOptions;
  /** The options in one canonical text, in the order hooks, rules, agents, skills; "" for none. */
  text: string;
}

const OPTIONS_HELP =
  "hooks=off, rules=on, rules=off, agents=off, agents=except:<glob>, agents=only:<glob>, skills=only:<glob>, skills=except:<glob>";

/**
 * Splits at the commas that are not inside braces, so that a glob such as `{a,b}` stays whole.
 * @param text - The options, joined by commas.
 * @returns Each part, trimmed.
 */
function splitOptions(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let part = "";
  for (const char of text) {
    if (char === "{") depth++;
    else if (char === "}" && depth > 0) depth--;
    if (char === "," && depth === 0) {
      parts.push(part);
      part = "";
    } else {
      part += char;
    }
  }
  return [...parts, part].map((each) => each.trim());
}

/**
 * Checks that a glob compiles and is not empty.
 * @param option - The whole option as written, for the message.
 * @param glob - The text after the option's second colon.
 * @returns The glob, once it is known to compile.
 * @throws {UsageError} For an empty glob or one with an unclosed brace.
 */
function requireGlob(option: string, glob: string): string {
  if (glob === "")
    throw new UsageError(`${option} needs a glob after the colon`);
  globToRegExp(glob);
  return glob;
}

/**
 * Reads one option into the options.
 * @param into - The options so far; it is changed.
 * @param option - One option of the list, such as `skills=only:magic-*`.
 * @param spec - The whole spec, for the message.
 * @throws {UsageError} For an option that is unknown, given twice, or contradicts one given before.
 */
function readOption(into: SubjectOptions, option: string, spec: string): void {
  const [key = "", ...rest] = option.split("=");
  const value = rest.join("=");
  const kind = value.split(":")[0] ?? "";
  const glob = value.slice(kind.length + 1);
  const had = (name: keyof SubjectOptions): void => {
    if (into[name] !== undefined) {
      throw new UsageError(
        `subject option ${name} is given twice, or two of its forms contradict each other, in "${spec}"`,
      );
    }
  };
  if (option === "hooks=off") {
    had("hooks");
    into.hooks = "off";
  } else if (option === "rules=on" || option === "rules=off") {
    had("rules");
    into.rules = value === "on" ? "on" : "off";
  } else if (option === "agents=off") {
    had("agents");
    into.agents = "off";
  } else if (key === "agents" && (kind === "except" || kind === "only")) {
    had("agents");
    const given = requireGlob(option, glob);
    into.agents = kind === "except" ? { except: given } : { only: given };
  } else if (key === "skills" && (kind === "only" || kind === "except")) {
    had("skills");
    into.skills = { mode: kind, glob: requireGlob(option, glob) };
  } else {
    throw new UsageError(
      `unknown subject option "${option}" in "${spec}"; the options are ${OPTIONS_HELP}`,
    );
  }
}

/**
 * Writes the options as one text, in a fixed order.
 * @param options - What a spec asked for.
 * @returns The options joined by commas; "" for none.
 */
function optionsText(options: SubjectOptions): string {
  const { hooks, rules, agents, skills } = options;
  return [
    ...(hooks ? [`hooks=${hooks}`] : []),
    ...(rules ? [`rules=${rules}`] : []),
    ...(agents === undefined
      ? []
      : [
          agents === "off"
            ? "agents=off"
            : `agents=${"except" in agents ? `except:${agents.except}` : `only:${agents.only}`}`,
        ]),
    ...(skills ? [`skills=${skills.mode}:${skills.glob}`] : []),
  ].join(",");
}

/**
 * Takes a subject spec apart: `<spec>[:<opt>[,<opt>…]]`. An existing path wins over the grammar, so a directory whose
 * name holds a colon is still a directory.
 * @param text - What the user typed.
 * @param cwd - What a relative path resolves against.
 * @returns The spec, the options and their canonical text.
 * @throws {UsageError} For an unknown option, a repeated or contradictory one, or an empty list after the colon.
 */
export function parseSpec(text: string, cwd: string): ParsedSpec {
  const colon = text.indexOf(":");
  if (colon < 0 || fs.existsSync(path.resolve(cwd, text))) {
    return { spec: text, options: {}, text: "" };
  }
  const spec = text.slice(0, colon);
  const list = text.slice(colon + 1);
  if (spec === "" || list.trim() === "") {
    throw new UsageError(
      `"${text}": a subject with options is <spec>:<option>[,<option>...], with ${OPTIONS_HELP}`,
    );
  }
  const options: SubjectOptions = {};
  for (const option of splitOptions(list)) readOption(options, option, text);
  return { spec, options, text: optionsText(options) };
}

/**
 * Tells whether the options ask for anything that only a harness can remove from an export.
 * @param options - What a spec asked for.
 * @returns True for `hooks=off` and for any `agents` option.
 */
export const needsHarness = (options: SubjectOptions): boolean =>
  options.hooks !== undefined || options.agents !== undefined;

/**
 * Tells whether a name matches the glob of a `skills` or `agents` option.
 * @param glob - The option's pattern; `*` and `{a,b}` as in `--case`.
 * @param name - A skill or agent name, without `.md`.
 * @returns True when the glob matches the whole name.
 */
export const matches = (glob: string, name: string): boolean =>
  globToRegExp(glob).test(name);

/**
 * Removes the skills that a `skills` option does not keep, from an export.
 * @param found - The export's skills: name to directory.
 * @param filter - The `skills` option.
 * @param root - The export's root; a skill that is the root itself loses its SKILL.md only.
 * @returns The names of the skills that were removed.
 * @throws {UsageError} When the option would leave no skill.
 */
export function pareSkills(
  found: Record<string, string>,
  filter: NonNullable<SubjectOptions["skills"]>,
  root: string,
): string[] {
  const kept = (name: string): boolean =>
    matches(filter.glob, name) === (filter.mode === "only");
  const names = Object.keys(found);
  if (!names.some(kept)) {
    throw new UsageError(
      `skills=${filter.mode}:${filter.glob} leaves no skill; the subject has ${names.join(", ") || "none"}`,
    );
  }
  const removed = names.filter((name) => !kept(name));
  for (const name of removed) {
    const dir = found[name] ?? "";
    if (dir === root) fs.rmSync(path.join(dir, "SKILL.md"), { force: true });
    else fs.rmSync(dir, { recursive: true, force: true });
  }
  return removed;
}
