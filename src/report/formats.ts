import { UsageError } from "../scope.js";

/** The report formats and the file each is written to; `md` is printed instead. */
export const FORMATS = {
  md: null,
  json: "report.json",
  junit: "report.xml",
  html: "report.html",
} as const;

/** One of `md`, `json`, `junit` and `html`. */
export type Format = keyof typeof FORMATS;

const isFormat = (text: string): text is Format => Object.hasOwn(FORMATS, text);

/**
 * Settles the report formats of a command.
 * @param options - The options after the config file was applied.
 * @param options.report - The formats asked for.
 * @param where - Names the option in the message. Default: `--report`.
 * @returns The formats, without repeats, in the order given; `md` alone when none was.
 * @throws {UsageError} When the list is empty, or a format is not one of md, json, junit and html.
 */
export function reportFormats(
  options: { report?: string[] | undefined },
  where = "--report",
): Format[] {
  const given = options.report ?? ["md"];
  if (given.length === 0)
    throw new UsageError(`${where} needs at least one format`);
  for (const text of given) {
    if (!isFormat(text)) {
      throw new UsageError(
        `${where} takes ${Object.keys(FORMATS).join(", ")}, not "${text}"`,
      );
    }
  }
  return [...new Set(given.filter(isFormat))];
}
