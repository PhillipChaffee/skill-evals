import { DEFAULT_WINDOW } from "./dispatch-rule.js";
import { DEFAULT_TIMEOUT_SECONDS } from "./checks/command.js";
import type { Check } from "./checks/index.js";
import { CHECKS } from "./checks/index.js";
import { TRANSCRIPT_CHARS } from "./judge-render.js";

/** The defaults of one check type, from the fields that the check leaves out. Each is what the rule applies. */
type Defaults = (check: Check) => Record<string, unknown>;

// A count that may be 0 when `max` is 0, as the call and dispatch rules read it.
const countMin = (check: Check): number => (check.max === 0 ? 0 : 1);

// What a judge or decision check shows the model, when `sees` is absent: the 0.0.1 prompt, byte for byte.
const MODEL_VIEW = { sees: ["final"], maxChars: TRANSCRIPT_CHARS };

// Types whose rules default a field. A type that is not here has no default beyond `weight` and `root`.
const DEFAULTS: Record<string, Defaults> = {
  tool_called: (check) => ({ min: countMin(check) }),
  tool_not_called: () => ({ min: 0, max: 0 }),
  agent_dispatched: (check) => ({
    min: countMin(check),
    briefWindow: DEFAULT_WINDOW,
  }),
  file_count: () => ({ min: 1 }),
  file_matches: () => ({ quantifier: "any" }),
  file_lacks: () => ({ quantifier: "all" }),
  transcript_matches: () => ({ where: "assistant_text", scope: "any" }),
  transcript_lacks: () => ({ where: "assistant_text", scope: "any" }),
  tool_output_matches: () => ({ which: "any" }),
  tool_output_lacks: () => ({ which: "any" }),
  command: () => ({
    expectExit: 0,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    scoreFrom: "exit",
  }),
  judge: () => ({ ...MODEL_VIEW, scale: "0-1", votes: 1 }),
  decision: () => MODEL_VIEW,
};

/**
 * Writes out every default that the rules of a check apply, so that a reader sees what a run will do.
 * @param check - Any check of a loaded case.
 * @returns The check with the fields it leaves out set to their defaults, as the rule reads them: the type's own, and
 *   `root: "workspace"` for a check that takes a root. A field the check sets is kept. A model-view field that does
 *   not apply, such as `maxChars` without `sees: ["transcript"]`, is left out.
 */
export function withDefaults(check: Check): Check {
  const spec = CHECKS[check.type];
  const takesRoot = [
    ...(spec?.fields ?? []),
    ...(spec?.optional ?? []),
  ].includes("root");
  const filled: Record<string, unknown> = {
    ...(takesRoot ? { root: "workspace" } : {}),
    ...DEFAULTS[check.type]?.(check),
    ...Object.fromEntries(
      Object.entries(check).filter(([, value]) => value !== undefined),
    ),
  };
  const sees = filled["sees"];
  if (Array.isArray(sees) && !sees.includes("transcript")) {
    delete filled["maxChars"];
  }
  return filled as unknown as Check;
}
