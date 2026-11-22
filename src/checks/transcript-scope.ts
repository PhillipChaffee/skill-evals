import { parseMatcher } from "../matchers.js";
import { UsageError } from "../scope.js";
import { registerParser } from "./fields.js";
import type { Scope } from "./transcript-slice.js";

const WORDS = ["first_message", "final_message", "any"];
const FORMS =
  'one of "first_message", "final_message", "any", an object with exactly one of "before" and "after", or "first_message": true with "before"';

// Reads a `scope`: a word, or an object of one of the three forms with exactly these keys.
registerParser("scope", (value, at): Scope => {
  const where = `${at.where}.${at.name}`;
  const wrong = new UsageError(`${where}: the scope must be ${FORMS}`);
  if (typeof value === "string") {
    if (!WORDS.includes(value)) throw wrong;
    return value as Scope;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw wrong;
  }
  const given = value as Record<string, unknown>;
  const keys = Object.keys(given).sort().join();
  const matcher = (key: string) => parseMatcher(given[key], `${where}.${key}`);
  if (keys === "before" || keys === "after") {
    return keys === "before"
      ? { before: matcher("before") }
      : { after: matcher("after") };
  }
  if (keys === "before,first_message" && given["first_message"] === true) {
    return { first_message: true, before: matcher("before") };
  }
  throw wrong;
});
