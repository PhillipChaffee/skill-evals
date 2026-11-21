import path from "node:path";
import type { Sandbox } from "./sandbox.js";

/** The one check of a case that `plant` writes. */
export const CHECKS = [{ type: "output_contains", text: "x" }];

/**
 * Plants one case directory at any depth.
 * @param box - Where to write it.
 * @param id - The path of the case under `cases/`.
 * @param more - Other keys of its case file; they win over the default check.
 * @returns The cases directory.
 */
export function plant(
  box: Sandbox,
  id: string,
  more: Record<string, unknown> = {},
): string {
  box.write(`cases/${id}/prompt.md`, `# ${id}\n\ndo it\n`);
  box.write(`cases/${id}/case.json`, { checks: CHECKS, ...more });
  return path.join(box.root, "cases");
}
