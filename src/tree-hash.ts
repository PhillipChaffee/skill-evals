import { createHash } from "node:crypto";
import { snapshot } from "./snapshot.js";

/**
 * Writes a value as JSON with the keys of every object in sorted order, so equal values give equal text.
 * @param value - Anything `JSON.stringify` takes.
 * @returns The JSON text.
 */
export const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, each: unknown) =>
    each !== null && typeof each === "object" && !Array.isArray(each)
      ? Object.fromEntries(
          Object.entries(each).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)),
        )
      : each,
  );

/**
 * Hashes text.
 * @param text - What to hash.
 * @returns The sha256 in hex.
 */
export const sha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

/**
 * Hashes the content of a directory: its sorted relative paths and the bytes of each file. A link is hashed by its
 * target text and never followed.
 * @param dir - The directory.
 * @returns The sha256 in hex.
 */
export const hashTree = (dir: string): string =>
  sha256(canonical(Object.fromEntries(snapshot(dir))));
