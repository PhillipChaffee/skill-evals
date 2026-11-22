import type { Scale } from "./checks/judge-fields.js";

/** What one judge call gave: a score, or null with the reason there is none. */
export interface Vote {
  score: number | null;
  reason: string;
}

const PAIR = 2;

const plural = (count: number, word: string): string =>
  `${String(count)} ${word}${count === 1 ? "" : "s"}`;

/**
 * Takes the middle of some scores.
 * @param scores - At least one score.
 * @returns The middle one, or the mean of the middle two when there is an even number.
 */
function median(scores: number[]): number {
  const sorted = [...scores].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / PAIR);
  return sorted.length % PAIR === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / PAIR;
}

/**
 * Settles one check from several votes.
 * @param votes - Every vote, in the order cast.
 * @param scale - "binary" takes the majority, with a tie scoring 0; "0-1" takes the median.
 * @returns The score and why. A vote with no score is left out of the count and named in the reason. The score is
 *   null, with the last vote's reason, only when no vote gave one.
 */
export function tally(votes: Vote[], scale: Scale): Vote {
  const usable = votes.flatMap(({ score }) => (score === null ? [] : [score]));
  const unusable = votes.length - usable.length;
  if (usable.length === 0) {
    return { score: null, reason: votes.at(-1)?.reason ?? "" };
  }
  const left =
    unusable > 0 ? `; ${plural(unusable, "vote")} gave no usable answer` : "";
  if (scale === "0-1") {
    const score = median(usable);
    const reason = `the median of ${plural(usable.length, "vote")} is ${String(score)}`;
    return { score, reason: reason + left };
  }
  const passes = usable.filter((score) => score === 1).length;
  const tie = passes * PAIR === usable.length;
  const head = `${String(passes)} of ${plural(usable.length, "vote")} pass`;
  return {
    score: passes * PAIR > usable.length ? 1 : 0,
    reason: `${head}${tie ? ", a tie scores 0" : ""}${left}`,
  };
}
