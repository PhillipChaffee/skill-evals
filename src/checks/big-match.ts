import { Worker } from "node:worker_threads";

/** How long one pattern may take on one large text, in a worker thread, before its check is unscored. */
const CHECK_MATCH_BUDGET_MS = 10_000;
// A text over this many UTF-8 bytes is matched in a worker thread, so that a slow pattern cannot block the event loop
// that the other runs of the command share.
const LARGE_TEXT_BYTES = 16_384;
// The most bytes a UTF-8 character takes, so that a text this many times shorter than the limit is never large.
const MOST_BYTES_PER_CHAR = 4;
const BYTES_PER_KB = 1024;
const MS_PER_SECOND = 1000;

let budgetMs = CHECK_MATCH_BUDGET_MS;

/**
 * Sets the budget of a match in a worker thread. Internal: a test sets a short budget so that it is fast.
 * @param ms - The budget in milliseconds; absent restores `CHECK_MATCH_BUDGET_MS`.
 */
export function setMatchBudget(ms: number = CHECK_MATCH_BUDGET_MS): void {
  budgetMs = ms;
}

/** A pattern that took longer than the budget on a large text. The check that tested it has no score. */
export class OverBudget extends Error {
  override name = "OverBudget";
}

/** One pattern, by its source and flags, and one text it was asked to test. */
interface Pair {
  source: string;
  flags: string;
  text: string;
}

/** What a pass of a rule knows: the answers the worker gave, and the pairs it still has to answer. */
interface Pass {
  /** Pattern key to text to whether it matched. */
  known: Map<string, Map<string, boolean>>;
  pending: Pair[];
}

// The pass of the rule that runs now. A rule is synchronous, so no other rule runs while it is set.
let current: Pass | null = null;

const keyOf = (pattern: RegExp): string => `${pattern.flags}/${pattern.source}`;

/**
 * Tells whether a text is large enough to be matched in a worker thread.
 * @param text - The text a pattern is tested against.
 * @returns True for a text of more than 16 KB in UTF-8.
 */
function isLarge(text: string): boolean {
  if (text.length <= LARGE_TEXT_BYTES / MOST_BYTES_PER_CHAR) return false;
  return (
    text.length > LARGE_TEXT_BYTES || Buffer.byteLength(text) > LARGE_TEXT_BYTES
  );
}

/**
 * Answers a test of a large text from what the worker found, during a pass of a rule.
 * @param pattern - The pattern, at position 0.
 * @param text - What the pattern is tested against.
 * @returns Whether it matched, when the worker already said; false for a pair it has not tested yet, which the pass
 *   then asks it about; undefined when the test is to run here: outside a pass, for a small text, and for a pattern
 *   whose position is not 0.
 */
function answered(pattern: RegExp, text: string): boolean | undefined {
  if (current === null || pattern.lastIndex !== 0 || !isLarge(text)) {
    return undefined;
  }
  const found = current.known.get(keyOf(pattern))?.get(text);
  if (found !== undefined) return found;
  current.pending.push({ source: pattern.source, flags: pattern.flags, text });
  return false;
}

/** The regular expression of a check. Its test of a large text, during a pass of a rule, is made in a worker thread. */
export class CheckPattern extends RegExp {
  /**
   * Tests a text, or answers from the worker's results for a large one.
   * @param text - What the pattern is tested against.
   * @returns Whether the pattern matches it.
   */
  override test(text: string): boolean {
    return answered(this, text) ?? super.test(text);
  }
}

// Runs in the worker: tests each pair in order and posts each answer as soon as it has it.
const WORKER = `const { parentPort, workerData } = require("node:worker_threads");
for (const { source, flags, text } of workerData) {
  parentPort.postMessage(new RegExp(source, flags).test(text));
}`;

/**
 * Tests pairs of a pattern and a large text in a worker thread, each within the budget.
 * @param pairs - What to test, in order.
 * @returns Whether each pattern matched its text, in order.
 * @throws {OverBudget} When one pair takes longer than the budget; the worker is stopped.
 * @throws {Error} When the worker fails, as a pattern that overflows the stack does.
 */
function inWorker(pairs: Pair[]): Promise<boolean[]> {
  return new Promise((resolve, reject) => {
    const answers: boolean[] = [];
    const worker = new Worker(WORKER, { eval: true, workerData: pairs });
    let timer: NodeJS.Timeout | undefined;
    const arm = (): void => {
      clearTimeout(timer);
      const pair = pairs[answers.length];
      if (pair === undefined) return;
      timer = setTimeout(() => {
        void worker.terminate();
        const kb = Math.ceil(Buffer.byteLength(pair.text) / BYTES_PER_KB);
        reject(
          new OverBudget(
            `the pattern took longer than ${String(budgetMs / MS_PER_SECOND)} s on ${String(kb)} KB`,
          ),
        );
      }, budgetMs);
    };
    worker.on("message", (answer: boolean) => {
      answers.push(answer);
      arm();
      if (answers.length === pairs.length) {
        void worker.terminate();
        resolve(answers);
      }
    });
    worker.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    arm();
  });
}

/**
 * Runs a synchronous rule so that its tests of large texts are made in a worker thread with a budget. The rule runs once
 * with every such test answered false and recorded; the worker answers the recorded ones; the rule runs again with
 * those answers, until a pass asks nothing new. A pass is cheap: no large text is matched in it, and each pass that
 * asks adds pairs the last did not know, of which a rule has finitely many.
 * @param rule - The rule, which may return a promise; only its synchronous part is passed over.
 * @returns What the last pass of the rule returned.
 * @throws {OverBudget} When a pattern takes longer than the budget on one text.
 */
export async function budgeted<T>(rule: () => T): Promise<Awaited<T>> {
  const known = new Map<string, Map<string, boolean>>();
  for (;;) {
    const pass: Pass = { known, pending: [] };
    current = pass;
    let result: { value: T } | null = null;
    try {
      result = { value: rule() };
    } catch (error) {
      // A rule that a false answer made throw runs again once the worker has answered.
      if (pass.pending.length === 0) throw error;
    } finally {
      current = null;
    }
    if (result !== null && pass.pending.length === 0) {
      return await result.value;
    }
    const answers = await inWorker(pass.pending);
    pass.pending.forEach(({ source, flags, text }, at) => {
      const key = `${flags}/${source}`;
      const texts = known.get(key) ?? new Map<string, boolean>();
      texts.set(text, answers[at] === true);
      known.set(key, texts);
    });
  }
}
