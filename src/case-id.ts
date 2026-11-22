// The control characters: the C0 block and DEL.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
/** The most bytes of one directory name that file systems take, which a case id's parts are. */
const MAX_PART_BYTES = 255;

/**
 * Says what is wrong with one directory name on the path of a case, by the rules of case ids. Discovery and `init`
 * share it.
 * @param name - The name of one directory.
 * @returns The problem, or null when a case may sit in a directory of that name. A name is not fine when it holds
 *   `@` (a variant) or `,` (a list of selectors), holds a control character (`\x00` to `\x1f`, `\x7f`), or is over 255
 *   bytes.
 */
export function nameProblem(name: string): string | null {
  if (/[@,]/.test(name)) {
    return 'a directory name may not hold "@" or ","';
  }
  if (CONTROL.test(name)) {
    return `a directory name may not hold a control character: ${JSON.stringify(name)}`;
  }
  if (Buffer.byteLength(name) > MAX_PART_BYTES) {
    return `a directory name may not be over ${String(MAX_PART_BYTES)} bytes`;
  }
  return null;
}

/**
 * Says what is wrong with a case id that someone typed, which may not yet be a directory.
 * @param id - The case's path below the cases directory, with `/`.
 * @returns The problem, or null when the id is fine: every part passes `nameProblem`, is not empty, `.` or `..`, and
 *   does not start with `_`, which discovery skips, so that a case there would never run.
 */
export function idProblem(id: string): string | null {
  const parts = id.split("/");
  const shown = JSON.stringify(id);
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    return `${shown} has an empty part, "." or ".."; an id is a path of folder names joined by "/"`;
  }
  const [bad] = parts.flatMap((part) => nameProblem(part) ?? []);
  if (bad !== undefined) return `${shown}: ${bad}`;
  if (parts.some((part) => part.startsWith("_"))) {
    return `${shown}: a directory name that starts with "_" is never a case`;
  }
  return null;
}
