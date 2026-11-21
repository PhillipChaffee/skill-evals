import type { Case, LoadOptions } from "./cases.js";
import { loadWhere } from "./cases.js";
import { globToRegExp } from "./glob.js";
import { UsageError } from "./scope.js";

/** Which cases a command works on. Every part that is set must hold; a part that is absent holds for every case. */
export interface Selection {
  /** Globs over case ids: a case is chosen when any of them matches its id. */
  ids?: string[];
  /** Globs over case ids: a case is dropped when any of them matches its id. */
  notIds?: string[];
  /** A case is chosen when it has any of these tags. */
  tagsAny?: string[];
  /** A case is chosen when it has every one of these tags. */
  tagsAll?: string[];
  /** A case is dropped when it has any of these tags. */
  notTags?: string[];
}

/** The options that make a `Selection`, under the names the code uses for the flags. */
export interface SelectionOptions {
  /** Globs over case ids to run; one glob, or a list of them. Default: every case. */
  caseGlob?: string | string[] | undefined;
  /** Globs over case ids to leave out. */
  notCase?: string[] | undefined;
  /** Run a case that has any of these tags. */
  tag?: string[] | undefined;
  /** Run a case that has all of these tags. */
  tagAll?: string[] | undefined;
  /** Leave out a case that has any of these tags. */
  notTag?: string[] | undefined;
}

/**
 * Splits the values of a repeatable flag into items.
 * @param values - Each time the flag was given, its text.
 * @returns The items: a comma separates them, except inside braces, where a comma belongs to the glob. Spaces around
 *   an item and empty items are dropped.
 */
export function splitList(values: string[]): string[] {
  return values.flatMap((text) => {
    const items: string[] = [];
    let depth = 0;
    let item = "";
    for (const char of text) {
      if (char === "{") depth++;
      else if (char === "}" && depth > 0) depth--;
      if (char === "," && depth === 0) {
        items.push(item);
        item = "";
      } else {
        item += char;
      }
    }
    return [...items, item].map((each) => each.trim()).filter(Boolean);
  });
}

/**
 * Makes the selection that the options of a command ask for.
 * @param options - The `--case`, `--not-case`, `--tag`, `--tag-all` and `--not-tag` options.
 * @returns The same request as a selection.
 */
export function selectionOf(options: SelectionOptions): Selection {
  const { caseGlob, notCase, tag, tagAll, notTag } = options;
  return {
    ...(caseGlob !== undefined && { ids: [caseGlob].flat() }),
    ...(notCase && { notIds: notCase }),
    ...(tag && { tagsAny: tag }),
    ...(tagAll && { tagsAll: tagAll }),
    ...(notTag && { notTags: notTag }),
  };
}

/**
 * Tells which ids a selection lets through, by id alone.
 * @param by - The selection; its tag parts are not looked at.
 * @returns A test for a case id.
 * @throws {UsageError} When a glob has a `{` that is never closed.
 */
function idTest(by: Selection): (id: string) => boolean {
  const wanted = (by.ids ?? ["**"]).map(globToRegExp);
  const unwanted = (by.notIds ?? []).map(globToRegExp);
  return (id) =>
    wanted.some((glob) => glob.test(id)) &&
    !unwanted.some((glob) => glob.test(id));
}

/**
 * Chooses cases.
 * @param cases - The loaded cases.
 * @param by - The selection.
 * @returns The cases that match every part of the selection, in their order.
 */
export function selectCases(cases: Case[], by: Selection): Case[] {
  const byId = idTest(by);
  const { tagsAny = [], tagsAll = [], notTags = [] } = by;
  return cases.filter(
    ({ id, tags }) =>
      byId(id) &&
      (tagsAny.length === 0 || tagsAny.some((tag) => tags.includes(tag))) &&
      tagsAll.every((tag) => tags.includes(tag)) &&
      !notTags.some((tag) => tags.includes(tag)),
  );
}

/**
 * Says what a selection asks for, for an error message.
 * @param by - The selection.
 * @returns A single glob in quotes when that is all it holds, else the flags that make it; an empty text for a
 *   selection that asks for nothing.
 */
function describe(by: Selection): string {
  const { ids = [], notIds = [], tagsAny = [], tagsAll = [] } = by;
  if (
    ids.length === 1 &&
    notIds.length +
      tagsAny.length +
      tagsAll.length +
      (by.notTags ?? []).length ===
      0
  ) {
    return `"${String(ids[0])}"`;
  }
  const parts: [string, string[]][] = [
    ["--case", ids],
    ["--not-case", notIds],
    ["--tag", tagsAny],
    ["--tag-all", tagsAll],
    ["--not-tag", by.notTags ?? []],
  ];
  const given = parts.filter(([, items]) => items.length > 0);
  if (given.length === 0) return "";
  return `the selection (${given.map(([flag, items]) => `${flag} ${items.join(",")}`).join(" ")})`;
}

/**
 * Loads the cases of a suite and chooses among them. A case whose id the selection rules out is never read.
 * @param casesDir - The directory to search at any depth.
 * @param by - Which cases to choose.
 * @param options - How to treat unknown keys.
 * @returns The chosen cases, sorted by id.
 * @throws {UsageError} When the directory cannot be read, a case is invalid, or no case is chosen.
 */
export function loadSelection(
  casesDir: string,
  by: Selection,
  options: LoadOptions,
): Case[] {
  const chosen = selectCases(loadWhere(casesDir, idTest(by), options), by);
  if (chosen.length === 0) {
    const asked = describe(by);
    throw new UsageError(
      `no case in ${casesDir}${asked && ` matches ${asked}`}`,
    );
  }
  return chosen;
}

/** How many of the cases name one skill as a target. */
export interface Coverage {
  skill: string;
  /** Every case that names it. */
  cases: number;
  /** The ones that are not guards. */
  dev: number;
  /** The held-out ones; none until held-out variants exist. */
  heldout: number;
  /** The guard cases. */
  guards: number;
}

/**
 * Counts the cases of each target skill.
 * @param cases - The chosen cases.
 * @returns One row for each name in the `targets` of any case, sorted by name.
 */
export function coverageOf(cases: Case[]): Coverage[] {
  const skills = [...new Set(cases.flatMap(({ targets }) => targets))].sort();
  return skills.map((skill) => {
    const named = cases.filter(({ targets }) => targets.includes(skill));
    const guards = named.filter(({ guard }) => guard).length;
    return {
      skill,
      cases: named.length,
      dev: named.length - guards,
      heldout: 0,
      guards,
    };
  });
}
