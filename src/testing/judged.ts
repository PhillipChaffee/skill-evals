import fs from "node:fs";
import path from "node:path";
import { plantCase, plugin } from "./plant.js";
import { readResults, sandbox } from "./sandbox.js";

export const REPLIES_FILE = "fake/judge/replies.json";
const PROMPTS_FILE = "fake/judge/prompts.jsonl";
export const SCORE_ONE = '{"score": 1}';
export const PASS = '{"reason": "ok", "verdict": "pass"}';
export const FAIL = '{"reason": "no", "verdict": "fail"}';

/**
 * Scores one planted case whose judge check is as given.
 * @param judged - The fields of the judge check besides its type.
 * @param replies - What the fake judge answers, in order.
 * @param more - More command line flags, and a hook that plants files before the run.
 * @param more.flags - Flags of `score`.
 * @param more.plant - Plants more files in the sandbox.
 * @returns The command's result, the prompts the judge got, and the run record.
 */
export async function judgedWith(
  judged: Record<string, unknown>,
  replies: string[],
  more: {
    flags?: string[];
    plant?: (box: ReturnType<typeof sandbox>) => void;
  } = {},
) {
  const box = sandbox();
  const owned = plugin(box, "plugin-owned", { answer: "It is fixed now." });
  const cases = plantCase(box, [{ type: "judge", ...judged }]);
  more.plant?.(box);
  box.write(REPLIES_FILE, replies);
  const out = path.join(box.root, "results");
  const flags = ["--cases", cases, "--reps", "1", "--out", out];
  const ran = await box.cli([
    ...["score", "--subject", owned, ...flags, ...(more.flags ?? [])],
  ]);
  const logged = path.join(box.root, PROMPTS_FILE);
  const prompts = fs.existsSync(logged)
    ? fs
        .readFileSync(logged, "utf8")
        .trim()
        .split("\n")
        .map((line) => (JSON.parse(line) as { prompt: string }).prompt)
    : [];
  return { ran, prompts, check: readResults(out).records[0]?.checks[0] };
}
