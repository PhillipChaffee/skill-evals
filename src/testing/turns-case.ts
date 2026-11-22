import path from "node:path";
import { loadCases } from "../cases.js";
import type { Sandbox } from "./sandbox.js";

export const CHECK = { type: "output_contains", text: "x" };
export const SECOND = "the second message\n";
const FILE = "cases/talk/case.json";

/**
 * Plants a case with two prompt files and the given case file.
 * @param box - The sandbox.
 * @param file - The keys of the case file; `checks` is added when absent.
 * @returns The cases directory.
 */
export function plant(box: Sandbox, file: Record<string, unknown>): string {
  box.write("cases/talk/one.md", "the first message\n");
  box.write("cases/talk/two.md", SECOND);
  box.write(FILE, { checks: [CHECK], ...file });
  return path.join(box.root, "cases");
}

/**
 * Loads the planted case and says why it fails.
 * @param box - The sandbox.
 * @param file - The keys of the case file.
 * @returns The error message with the sandbox's path written as ROOT; "" when the case loads.
 */
export const failure = (
  box: Sandbox,
  file: Record<string, unknown>,
): string => {
  try {
    loadCases(plant(box, file));
  } catch (error) {
    return String(error instanceof Error ? error.message : error).replaceAll(
      box.root,
      "ROOT",
    );
  }
  return "";
};
