import fs from "node:fs";
import path from "node:path";
import type { Evaluation } from "../evaluate.js";
import type { Format } from "./formats.js";
import { FORMATS } from "./formats.js";
import { renderHtml } from "./html.js";
import { renderJson } from "./json.js";
import { renderJunit } from "./junit.js";
import { renderReport } from "./markdown.js";

const RENDERERS: Record<Format, (evaluation: Evaluation) => string> = {
  md: renderReport,
  json: renderJson,
  junit: renderJunit,
  html: renderHtml,
};

/**
 * Writes the reports a command was asked for.
 * @param evaluation - What `evaluate` returned.
 * @param formats - The formats, from `reportFormats`.
 * @returns The paths of the files written, in the order of `formats`, each also named on standard error as `wrote <path>`.
 *   The markdown report is printed to standard output instead, and only when `md` is in the list.
 */
export function emitReports(
  evaluation: Evaluation,
  formats: Format[],
): string[] {
  const written: string[] = [];
  for (const format of formats) {
    const text = RENDERERS[format](evaluation);
    const file = FORMATS[format];
    if (file === null) {
      console.log(text);
      continue;
    }
    const target = path.join(evaluation.outDir, file);
    fs.writeFileSync(target, text);
    written.push(target);
    console.error(`skill-evals: wrote ${target}`);
  }
  return written;
}
