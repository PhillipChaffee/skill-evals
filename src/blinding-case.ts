import path from "node:path";
import { agentSources } from "./blinding-agent.js";
import { readUnblinded, textHits } from "./blinding.js";
import type { Case } from "./cases.js";
import type { Lint } from "./commands/validate.js";
import { walkTree } from "./walk.js";

const SHOWN_EXAMPLES = 3;
const WHY = "which may tell the agent that it is being evaluated";

/**
 * Lists the paths below a directory, as the agent sees them.
 * @param dir - A directory of the case; null for one it does not have.
 * @returns The relative paths of its files and directories, with `/`; none for null.
 */
export function pathsUnder(dir: string | null): string[] {
  const found: string[] = [];
  if (dir === null) return found;
  walkTree(dir, {
    visit: ({ relative }) => {
      found.push(relative);
      return undefined;
    },
  });
  return found;
}

/**
 * Writes the warnings for the paths of one area.
 * @param place - The id of the case, and the area that the paths are in, such as "workspace/".
 * @param place.caseId - Names the case in each warning.
 * @param place.area - Names the area, such as "workspace/".
 * @param paths - The relative paths in it.
 * @param words - The words to look for.
 * @returns One warning for each word, with up to three of the paths that hold it.
 */
export function pathLints(
  place: { caseId: string; area: string },
  paths: string[],
  words: readonly string[],
): Lint[] {
  const { caseId, area } = place;
  const hits = paths.map((one) => ({ one, found: textHits(one, words) }));
  return words.flatMap((word): Lint[] => {
    const holding = hits
      .filter(({ found }) => found.includes(word))
      .map(({ one }) => one);
    if (holding.length === 0) return [];
    const more = holding.length - SHOWN_EXAMPLES;
    const shown = holding.slice(0, SHOWN_EXAMPLES).join(", ");
    return [
      {
        level: "warning",
        caseId,
        text: `${area} holds "${word}" in ${String(holding.length)} path${holding.length === 1 ? "" : "s"}, ${WHY}: ${shown}${more > 0 ? ` and ${String(more)} more` : ""}`,
      },
    ];
  });
}

/**
 * Takes out of the words the ones that a case may show.
 * @param caseDef - A loaded case, which may be one variant of a case file.
 * @param words - The blinding words.
 * @returns The words that the case's `x-unblinded` does not list.
 */
export function activeWords(
  caseDef: Case,
  words: readonly string[],
): readonly string[] {
  const silenced = readUnblinded(caseDef.extensions, "case")?.words ?? [];
  return words.filter((word) => !silenced.includes(word));
}

/**
 * Finds the blinding words in a case.
 * @param caseDef - A loaded case, which may be one variant of a case file.
 * @param words - The blinding words. The words that the case's `x-unblinded` lists are left out.
 * @param options - Whether to look at the paths too; a variant shares them with its case, so only one of them needs to.
 * @param options.paths - Look at the names of the files under `workspace/`, the shared fixtures and `home/`. Default: true.
 * @returns A warning for each word in each place: the prompt or turns, the seeded history and sessions, the mock MCP
 *   servers, and the paths (names, not contents). Subject content and the judge's prompt are not scanned.
 */
export function scanCase(
  caseDef: Case,
  words: readonly string[],
  options: { paths?: boolean } = {},
): Lint[] {
  const active = activeWords(caseDef, words);
  if (active.length === 0) return [];
  const found = agentSources(caseDef).flatMap(({ where, text }) =>
    textHits(text, active).map((word): Lint => ({
      level: "warning",
      caseId: caseDef.id,
      text: `${where} holds "${word}", ${WHY}`,
    })),
  );
  // A tool description and a response may each hold the word; one line says it.
  const texts = [...new Map(found.map((lint) => [lint.text, lint])).values()];
  if (options.paths === false) return texts;
  const areas = [
    ...[...caseDef.fixtureDirs, caseDef.workspaceDir].flatMap((dir) =>
      dir === null
        ? []
        : [{ area: `${path.basename(dir)}/`, paths: pathsUnder(dir) }],
    ),
    { area: "home/", paths: pathsUnder(caseDef.homeDir) },
  ];
  return [
    ...texts,
    ...areas.flatMap(({ area, paths }) =>
      pathLints({ caseId: caseDef.id, area }, paths, active),
    ),
  ];
}

/**
 * Finds the blinding words in every case of a suite.
 * @param cases - The loaded cases, variants included.
 * @param words - The blinding words.
 * @returns The warnings of `scanCase`; the paths of a case are looked at once, for its first variant.
 */
export function scanCases(cases: Case[], words: readonly string[]): Lint[] {
  const seen = new Set<string>();
  return cases.flatMap((one) => {
    const first = !seen.has(one.base);
    seen.add(one.base);
    return scanCase(one, words, { paths: first });
  });
}
