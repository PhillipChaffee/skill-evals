import type { Case, LoadOptions } from "./cases.js";
import { loadWhere } from "./cases.js";
import { baseGlobOf, globToRegExp } from "./glob.js";
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
  /** Also choose the held-out variants. Without it they are left out. */
  heldout?: boolean;
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
  /** Also run the held-out variants. */
  heldout?: boolean | undefined;
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
  const { caseGlob, notCase, tag, tagAll, notTag, heldout } = options;
  return {
    ...(caseGlob !== undefined && { ids: [caseGlob].flat() }),
    ...(notCase && { notIds: notCase }),
    ...(tag && { tagsAny: tag }),
    ...(tagAll && { tagsAll: tagAll }),
    ...(notTag && { notTags: notTag }),
    ...(heldout && { heldout }),
  };
}

/** What the id parts of a selection say, as two tests. */
interface IdTests {
  /** Decides from a case's path, before the case is read, whether it may be chosen. */
  mayLoad: (base: string) => boolean;
  /** Decides whether a loaded case or variant is chosen: a glob matches its full id or its case's path. */
  chooses: (one: Pick<Case, "id" | "base">) => boolean;
}

/**
 * Tells which ids a selection lets through.
 * @param by - The selection; its tag parts are not looked at.
 * @returns The two tests. A glob that names a variant is tried on the case's path by its part before the `@`, so a
 *   case that part does not reach is never read.
 * @throws {UsageError} When a glob has a `{` that is never closed.
 */
function idTests(by: Selection): IdTests {
  const wantedText = by.ids ?? ["**"];
  const wanted = wantedText.map(globToRegExp);
  const unwanted = (by.notIds ?? []).map(globToRegExp);
  const anyOf = (globs: RegExp[], ...ids: string[]) =>
    globs.some((glob) => ids.some((id) => glob.test(id)));
  const wantedBases = wantedText.map((glob) => globToRegExp(baseGlobOf(glob)));
  return {
    mayLoad: (base) => anyOf(wantedBases, base) && !anyOf(unwanted, base),
    chooses: ({ id, base }) =>
      anyOf(wanted, id, base) && !anyOf(unwanted, id, base),
  };
}

/**
 * Chooses cases.
 * @param cases - The loaded cases.
 * @param by - The selection.
 * @returns The cases that match every part of the selection, in their order. A held-out variant is left out unless
 *   `by.heldout` is set. A tag filter looks at the tags of the variant, which include its case's.
 */
export function selectCases(cases: Case[], by: Selection): Case[] {
  const { chooses } = idTests(by);
  const { tagsAny = [], tagsAll = [], notTags = [] } = by;
  return cases.filter(
    (one) =>
      chooses(one) &&
      (by.heldout === true || !one.heldout) &&
      (tagsAny.length === 0 || tagsAny.some((tag) => one.tags.includes(tag))) &&
      tagsAll.every((tag) => one.tags.includes(tag)) &&
      !notTags.some((tag) => one.tags.includes(tag)),
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
  const loaded = loadWhere(casesDir, idTests(by).mayLoad, options);
  const chosen = selectCases(loaded, by);
  if (chosen.length === 0) {
    const asked = describe(by);
    const hidden =
      selectCases(loaded, { ...by, heldout: true }).length > 0
        ? "; held-out variants run only with --heldout"
        : "";
    throw new UsageError(
      `no case in ${casesDir}${asked && ` matches ${asked}`}${hidden}`,
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
  /** The held-out variants that are not guards. */
  heldout: number;
  /** The guard cases. */
  guards: number;
}

/**
 * Counts the cases of each target skill.
 * @param cases - The chosen cases.
 * @returns One row for each name in the `targets` of any case, sorted by name. A guard counts as a guard, a held-out
 *   variant that is no guard as held-out, and the rest as dev.
 */
export function coverageOf(cases: Case[]): Coverage[] {
  const skills = [...new Set(cases.flatMap(({ targets }) => targets))].sort();
  return skills.map((skill) => {
    const named = cases.filter(({ targets }) => targets.includes(skill));
    const guards = named.filter(({ guard }) => guard).length;
    const heldout = named.filter((one) => one.heldout && !one.guard).length;
    return {
      skill,
      cases: named.length,
      dev: named.length - guards - heldout,
      heldout,
      guards,
    };
  });
}
