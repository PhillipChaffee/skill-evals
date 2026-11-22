import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Scale } from "./checks/judge-fields.js";
import type { Attachment } from "./judge-api.js";
import type { Memo, Spot } from "./judge.js";
import type { Usage } from "./run-plan.js";

const CACHE_FILE = "judge-cache.jsonl";

/** What the cache keeps of one usable judge answer. */
interface CacheValue {
  score: number;
  reason: string;
  /** What the call cost when it was made. A hit costs nothing. */
  usage: Usage;
}

/** Judge answers by key. */
export interface Cache {
  get(key: string): CacheValue | undefined;
  set(key: string, value: CacheValue): void;
}

/** One question to the judge: what the key is made of. */
interface Question {
  /** The judge's whole prompt, which holds the rubric and what the judge sees. */
  prompt: string;
  /** The files sent with it; each counts by its hash. */
  attachments: { sha256: string }[];
  /** The judge's model; empty when the harness picks. */
  model: string;
  /** How the judge scores. */
  scale: Scale;
  /** The index of the vote, so that votes of one question are independent. */
  vote: number;
  /** How the judge is reached: the judge harness's id, or "api". */
  via: string;
}

/**
 * Names one question to the judge.
 * @param question - What the key is made of.
 * @returns A sha256 in hex.
 */
export const cacheKey = (question: Question): string =>
  crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        question.prompt,
        question.attachments.map(({ sha256 }) => sha256),
        question.model,
        question.scale,
        question.vote,
        question.via,
      ]),
    )
    .digest("hex");

/**
 * Opens the judge cache of an output directory.
 * @param outDir - The output directory, which exists.
 * @param read - Whether answers are served from the cache. Default: false, so a fresh run asks every question and
 *   only writes; `--resume` and `rejudge` turn it on.
 * @returns A cache that, when it reads, holds what `judge-cache.jsonl` there holds now, and every answer added since;
 *   a line that is damaged or has no score is left out. `set` always adds a line to the file.
 */
export function openCache(outDir: string, read = false): Cache {
  const file = path.join(outDir, CACHE_FILE);
  const kept = new Map<string, CacheValue>();
  if (read && fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      try {
        const { key, ...value } = JSON.parse(line) as {
          key: string;
        } & CacheValue;
        if (typeof value.score === "number") kept.set(key, value);
      } catch {
        // A damaged line is a question to ask again.
      }
    }
  }
  return {
    get: (key) => kept.get(key),
    set(key, value) {
      if (read) kept.set(key, value);
      fs.appendFileSync(file, `${JSON.stringify({ key, ...value })}\n`);
    },
  };
}

/**
 * Lets the judge use the cache.
 * @param cache - Where the answers are kept.
 * @param fixed - What the key holds besides the prompt and the vote.
 * @param fixed.model - The judge's model; empty when the harness picks.
 * @param fixed.attachments - The files sent with the prompt.
 * @param fixed.scale - How the judge scores.
 * @param fixed.via - The judge harness's id, or "api".
 * @returns What `judge` asks before a vote and tells after one.
 */
export function memoOf(
  cache: Cache,
  fixed: Omit<Question, "prompt" | "vote"> & { attachments: Attachment[] },
): Memo<Usage> {
  const keyOf = (spot: Spot): string => cacheKey({ ...fixed, ...spot });
  return {
    recall: (spot) => cache.get(keyOf(spot)),
    remember(spot, given, reply) {
      const { durationMs, tokens, costUsd } = reply;
      cache.set(keyOf(spot), {
        ...given,
        usage: { durationMs, tokens, costUsd },
      });
    },
  };
}
