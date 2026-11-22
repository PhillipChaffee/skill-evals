import type { FieldDef } from "./fields.js";

/** What a field is when a check leaves it out. The rules, `explain` and the docs all read this one table. */
export interface FieldDefault {
  /**
   * The default by check type; the key `*` is the default of any type that has no key of its own. A function reads the
   * fields the check does set, and returns undefined when no default applies to that check.
   */
  value: Record<string, unknown>;
  /** What the value alone does not say, for the docs. */
  note?: string;
}

/** The `weight` of a check or of a case, which every one of them may carry. */
export const WEIGHT: FieldDef = {
  type: "number",
  meaning: "A positive number that says how much it counts.",
  default: { value: { "*": 1 } },
};
