import path from "node:path";
import { loadCases } from "../cases.js";
import type { History } from "../history-types.js";
import type { Sandbox } from "./sandbox.js";
import { readResults, sandbox, seenBy } from "./sandbox.js";

const MESSAGES = 12;
// The message that makes a tool call, counting from 0.
const CALLING = 3;
const EVEN = 2;
const USAGE_ERROR = 2;
// What a `score` of the planted cases with no subject starts from.
const BASE = ["score", "--subject", "none", "--reps", "1"];

/**
 * Makes a history of twelve messages, with two decisions left waiting and one tool call with its output.
 * @returns The messages, which alternate between the user and the assistant, starting with the user.
 */
export function twelveMessages(): History {
  return Array.from({ length: MESSAGES }, (_, index) => {
    const user = index % EVEN === 0;
    return {
      role: user ? "user" : "assistant",
      text: user ? `question ${String(index)}` : `answer ${String(index)}`,
      ...(index === CALLING
        ? {
            toolCalls: [
              {
                name: "Bash",
                input: { command: "git status" },
                output: "nothing to commit",
              },
            ],
          }
        : {}),
    };
  });
}

/** What a planted case holds besides its prompt. */
interface Planted {
  history?: unknown;
  sessions?: unknown;
  /** Other keys of the case file. Default: one check that the final text holds `history`. */
  caseFile?: Record<string, unknown>;
  prompt?: string;
}

/**
 * Plants one case with a history and, if asked, sessions.
 * @param box - The sandbox.
 * @param id - The case's id.
 * @param planted - What the case holds.
 * @returns The cases directory.
 */
export function plantSeeded(
  box: Sandbox,
  id: string,
  planted: Planted = {},
): string {
  box.write(`cases/${id}/prompt.md`, `${planted.prompt ?? `do ${id}`}\n`);
  box.write(`cases/${id}/case.json`, {
    checks: [{ type: "output_contains", text: "history" }],
    ...planted.caseFile,
  });
  if (planted.history !== undefined) {
    box.write(`cases/${id}/history.json`, planted.history);
  }
  if (planted.sessions !== undefined) {
    box.write(`cases/${id}/sessions/sessions.json`, planted.sessions);
  }
  return path.join(box.root, "cases");
}

/**
 * Scores the planted cases with the fake harness.
 * @param box - The sandbox.
 * @param flags - More flags of `score`.
 * @param env - More environment variables.
 * @returns The command's result, the results it wrote (none after a usage error), and what the fake saw in each run.
 */
export async function scoreSeeded(
  box: Sandbox,
  flags: string[] = [],
  env: Record<string, string> = {},
) {
  const out = path.join(box.root, "results");
  const ran = await box.cli(
    [
      ...BASE,
      ...["--out", out],
      ...["--cases", path.join(box.root, "cases")],
      ...flags,
    ],
    env,
  );
  const results = ran.status === USAGE_ERROR ? null : readResults(out);
  const seen = (results?.records ?? []).map((record) =>
    record.finalText.startsWith("{") ? seenBy(record.finalText) : null,
  );
  return { ran, results, seen, out };
}

/**
 * Plants a case with a history or sessions, and makes a function that loads it. Unknown keys of the case file are
 * dropped (`lenient`), which must not relax the files of the history.
 * @param planted - What the case holds besides its prompt.
 * @returns The sandbox, the cases directory, and `load`, which loads the case and throws what loading throws.
 */
export function seededLoad(planted: Pick<Planted, "history" | "sessions">) {
  const box = sandbox();
  const dir = plantSeeded(box, "seeded", planted);
  return {
    box,
    dir,
    load: () => loadCases(dir, "seeded", { lenient: true })[0],
  };
}
