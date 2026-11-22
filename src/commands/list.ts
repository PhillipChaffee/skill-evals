import fs from "node:fs";
import { HARNESSES, findBin } from "../harnesses/index.js";
import type { Project } from "../project.js";
import { withConfig } from "../project.js";
import { renderCoverage } from "../report/markdown.js";
import { coverageOf, loadSelection, selectionOf } from "../select.js";
import type { Options } from "../usage.js";

/**
 * Prints the harnesses in default-preference order, each with where it is installed, and the cases.
 * @param given - The options of the command line.
 * @param project - Where the config file and the default cases directory are.
 * @returns The exit code, always 0: a missing cases directory is a line of the listing.
 */
export function list(given: Options, project: Project): number {
  const options = withConfig(project, given);
  const installed = HARNESSES.map((harness) => ({
    harness,
    bin: findBin(harness),
  }));
  const first = installed.find((entry) => entry.bin);
  const chosen = fs.existsSync(options.cases)
    ? loadSelection(options.cases, selectionOf(options), {
        lenient: options.lenient ?? false,
      })
    : null;
  const cases = chosen
    ? [
        ...chosen.map(
          (caseDef) =>
            `- ${caseDef.id}: ${String(caseDef.checks.length)} checks`,
        ),
        "",
        `${String(chosen.length)} cases selected`,
        ...(options.targets ? ["", ...renderCoverage(coverageOf(chosen))] : []),
      ]
    : ["- none: the directory does not exist"];
  console.log(
    [
      "Harnesses, in default-preference order:",
      ...installed.map(
        ({ harness, bin }) =>
          `- ${harness.id}: ${bin ? `installed (${bin})` : `not installed ("${harness.bin}" not found)`}`,
      ),
      `Default harness: ${first ? first.harness.id : "none installed"}`,
      "",
      `Cases in ${options.cases}:`,
      ...cases,
    ].join("\n"),
  );
  return 0;
}
