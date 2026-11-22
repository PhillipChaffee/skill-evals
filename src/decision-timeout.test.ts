import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { decisionServer } from "./testing/decision-server.js";
import { plantCase } from "./testing/plant.js";
import { readResults, sandbox } from "./testing/sandbox.js";

const MODEL = "decider-one";
const KEY = "skill-evals-decision-key";
const USAGE_ERROR = 2;
const TIMEOUT_FLAG = "--decision-timeout";
const TWO_TIMEOUTS_MS = 2000;
/** A timer measured by wall clock can read slightly under its delay. */
const CLOCK_SLACK_MS = 100;
const UNDER_CONFIG_TIMEOUT_MS = 8000;
const PLAIN = { type: "decision", question: "Is it plain?", expect: "yes" };

/**
 * Scores one decision check against an API that never answers.
 * @param extra - More flags.
 * @param config - The project's config file.
 * @returns What the command did, where its results are, and what the API received.
 */
async function unanswered(extra: string[], config: Record<string, unknown>) {
  const box = sandbox();
  const server = await decisionServer([{ hang: true }]);
  const cases = plantCase(box, [PLAIN]);
  const outDir = path.join(box.root, "results");
  box.write("skill-evals.config.json", { ...config, decisionUrl: server.url });
  const flags = ["--subject", "none", "--cases", cases, "--out", outDir];
  const result = await box.cli(
    ["score", ...flags, "--reps", "1", "--decision-model", MODEL, ...extra],
    { BASETEN_API_KEY: KEY },
  );
  return { result, outDir, received: server.received };
}

test.each([
  ["the flag", [TIMEOUT_FLAG, "1"], {}],
  ["the config key", [], { decisionTimeout: 1 }],
  ["the flag over the config key", [TIMEOUT_FLAG, "1"], { decisionTimeout: 9 }],
])(
  "%s sets how long a request to the decision model may take",
  async (_, extra, config) => {
    const { result, outDir } = await unanswered(extra, config);
    expect(result.status).toBe(1);
    const [record] = readResults(outDir).records;
    expect(record?.checks[0]?.reason).toMatch(/timeout/i);
    expect(record?.decision?.calls).toBe(2);
    expect(
      record?.decision?.durationMs,
      "two requests of about one second, on a clock that can read a millisecond short",
    ).toBeGreaterThanOrEqual(TWO_TIMEOUTS_MS - CLOCK_SLACK_MS);
    expect(record?.decision?.durationMs).toBeLessThan(UNDER_CONFIG_TIMEOUT_MS);
  },
);

test.each([
  [[TIMEOUT_FLAG, "0"], {}],
  [[TIMEOUT_FLAG, "1.5"], {}],
  [[TIMEOUT_FLAG, "soon"], {}],
  [[TIMEOUT_FLAG, "4294968"], {}],
  [[], { decisionTimeout: -1 }],
])(
  "the decision timeout %j with the config %j is a usage error before any run",
  async (extra, config) => {
    const { result, outDir, received } = await unanswered(extra, config);
    expect(result.status).toBe(USAGE_ERROR);
    expect(result.stderr).toMatch(
      /decisionTimeout must be a positive integer of seconds, at most 4294967|--decision-timeout is not a decimal number/,
    );
    expect(received).toHaveLength(0);
    expect(fs.existsSync(outDir), "no run started").toBe(false);
  },
);
