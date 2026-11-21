import fs from "node:fs";
import { HARNESSES } from "../harnesses/index.js";
import type { Parsed } from "../harnesses/shared.js";
import { fixture } from "./sandbox.js";

/**
 * Normalizes a stream with one harness's adapter.
 * @param id - The harness.
 * @param stdout - What the harness wrote.
 * @returns What the adapter read.
 * @throws {Error} For an id that no harness has, and whatever the adapter throws on a stream it cannot read.
 */
export function parseText(id: string, stdout: string): Parsed {
  const harness = HARNESSES.find((candidate) => candidate.id === id);
  if (!harness) throw new Error(`no harness "${id}"`);
  return harness.parse(stdout);
}

/**
 * Normalizes a captured stream of `test/fixtures`.
 * @param id - The harness that wrote it.
 * @param name - The file name of the capture.
 * @returns What the adapter read.
 */
export const parse = (id: string, name: string): Parsed =>
  parseText(id, fs.readFileSync(fixture(name), "utf8"));

/**
 * Writes a stream by hand.
 * @param events - The events, in order.
 * @returns One JSON object per line.
 */
export const lines = (...events: unknown[]): string =>
  events.map((event) => JSON.stringify(event)).join("\n");
