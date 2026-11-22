import fs from "node:fs";
import path from "node:path";
import type { Canned } from "./judge-server.js";
import { judgeServer } from "./judge-server.js";
import { plantCase, plugin } from "./plant.js";
import type { EvaluateOptions } from "../evaluate.js";
import { evaluate } from "../evaluate.js";
import { asProcess, readResults, sandbox } from "./sandbox.js";

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
 * @param more.env - Variables of the command's environment.
 * @param more.config - The project's config file; none when absent.
 * @returns The command's result, the prompts the judge got, and the run record.
 */
export async function judgedWith(
  judged: Record<string, unknown>,
  replies: string[],
  more: {
    flags?: string[];
    plant?: (box: ReturnType<typeof sandbox>) => void;
    env?: Record<string, string>;
    config?: Record<string, unknown>;
  } = {},
) {
  const box = sandbox();
  const owned = plugin(box, "plugin-owned", { answer: "It is fixed now." });
  const cases = plantCase(box, [{ type: "judge", ...judged }]);
  more.plant?.(box);
  if (more.config) box.write("skill-evals.config.json", more.config);
  box.write(REPLIES_FILE, replies);
  const out = path.join(box.root, "results");
  const flags = ["--cases", cases, "--reps", "1", "--out", out];
  const ran = await box.cli(
    [...["score", "--subject", owned, ...flags, ...(more.flags ?? [])]],
    more.env,
  );
  const logged = path.join(box.root, PROMPTS_FILE);
  const prompts = fs.existsSync(logged)
    ? fs
        .readFileSync(logged, "utf8")
        .trim()
        .split("\n")
        .map((line) => (JSON.parse(line) as { prompt: string }).prompt)
    : [];
  const [record] = readResults(out).records;
  return { ran, prompts, check: record?.checks[0], record, out, box };
}

export const API_KEY = "skill-evals-judge-key";

/**
 * Plants one case with a judge check and a stand-in Messages API, for a command that can be run again into the same
 * output directory.
 * @param judged - The fields of the judge check besides its type.
 * @param script - What the stand-in API answers, in order.
 * @param more - Extra files and configuration.
 * @param more.plant - Plants more files in the sandbox.
 * @param more.config - The project's config file.
 * @param more.answer - What the agent says; null for the fake's report of what it saw. Default: a fixed sentence.
 * @returns The sandbox, the API's received requests, a function that scores the case through the command line, and one
 *   that calls `evaluate` with more options.
 */
export async function apiCase(
  judged: Record<string, unknown>,
  script: Canned[],
  more: {
    plant?: (box: ReturnType<typeof sandbox>) => void;
    config?: Record<string, unknown>;
    answer?: string | null;
  } = {},
) {
  const box = sandbox();
  const server = await judgeServer(script);
  const { answer = "It is fixed now." } = more;
  const owned = plugin(box, "plugin-owned", answer === null ? {} : { answer });
  const cases = plantCase(box, [{ type: "judge", ...judged }]);
  more.plant?.(box);
  if (more.config) box.write("skill-evals.config.json", more.config);
  const out = path.join(box.root, "results");
  const run = async (
    flags: string[] = [],
    env: Record<string, string> = { ANTHROPIC_API_KEY: API_KEY },
  ) => {
    const ran = await box.cli(
      [
        ...["score", "--subject", owned, "--cases", cases, "--reps", "1"],
        ...[
          "--out",
          out,
          "--judge-api",
          "anthropic",
          "--judge-url",
          server.url,
        ],
        ...flags,
      ],
      env,
    );
    const file = path.join(out, "results.json");
    const record = fs.existsSync(file)
      ? readResults(out).records[0]
      : undefined;
    return { ran, record, check: record?.checks[0] };
  };
  const evaluated = (more: Partial<EvaluateOptions> = {}) =>
    evaluateCase(box, {
      subjects: [owned],
      cases,
      reps: 1,
      outDir: out,
      judgeApi: "anthropic",
      judgeUrl: server.url,
      ...more,
    });
  return { box, out, received: server.received, run, evaluated };
}

/**
 * Calls `evaluate` itself, for options that no flag sets: `--resume` and `rejudge` will turn the cache on.
 * @param box - The sandbox, whose environment the call gets, with the judge key.
 * @param options - What to evaluate.
 * @returns The first run's record and its first check.
 */
async function evaluateCase(
  box: ReturnType<typeof sandbox>,
  options: EvaluateOptions,
) {
  const { value } = await asProcess(
    { env: { ...box.env, ANTHROPIC_API_KEY: API_KEY }, cwd: box.root },
    () => evaluate(options),
  );
  const [record] = value.records;
  return { record, check: record?.checks[0] };
}
