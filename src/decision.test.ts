import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { CONFIG_FILE } from "./project.js";
import type { Scripted } from "./testing/decision-server.js";
import { choice, decisionServer, yesNo } from "./testing/decision-server.js";
import { plantCase, plugin } from "./testing/plant.js";
import { readResults, sandbox, seenBy, tableRow } from "./testing/sandbox.js";
import { EXIT } from "./exit-codes.js";

const ANSWER = "It is fixed now.";
const MODEL = "decider-one";
// The stand-in harness counts the environment entries that match /skill.evals/, so this value shows up there.
const KEY = "skill-evals-decision-key";
const USAGE_ERROR = 2;
const MODEL_FLAG = "--decision-model";
const URL_FLAG = "--decision-url";
const PLAIN = { type: "decision", question: "Is it plain?", expect: "yes" };
const KEPT = {
  type: "decision",
  question: "How well is the meaning kept?",
  options: { fully: 1, mostly: 0.7, partly: 0.3, "not at all": 0 },
};
const CHECKS = [
  { ...PLAIN, weight: 2 },
  { type: "decision", question: "Does it mention weather?", expect: "no" },
  KEPT,
  { type: "output_contains", text: "fixed" },
];
const ANSWERS = {
  q1: yesNo(0.9),
  q2: yesNo(0.25),
  q3: choice({ fully: 0.5, mostly: 0.3, partly: 0.1, "not at all": 0.1 }),
};

/**
 * Runs a suite whose one case has decision checks, against the stand-in API.
 * @param script - What the API answers, one entry for each request.
 * @param checks - The checks of the case.
 * @param command - The command and its subject flags; by default it scores a plugin that gives a fixed answer.
 * @returns What the command did, what the API received, and the results file.
 */
async function decided(
  script: Scripted[],
  checks: unknown[],
  command?: (alpha: string, beta: string) => string[],
) {
  const box = sandbox();
  const server = await decisionServer(script);
  const alpha = plugin(box, "plugin-alpha", { answer: ANSWER });
  const beta = plugin(box, "plugin-beta", { answer: ANSWER });
  box.write(CONFIG_FILE, PASS_THE_KEY);
  const cases = plantCase(box, checks);
  const outDir = path.join(box.root, "results");
  const flags = ["--cases", cases, "--out", outDir, "--reps", "1"];
  const result = await box.cli(
    [
      ...(command?.(alpha, beta) ?? ["score", "--subject", alpha]),
      ...flags,
      ...[MODEL_FLAG, MODEL, URL_FLAG, server.url],
    ],
    { BASETEN_API_KEY: KEY },
  );
  return { box, result, outDir, received: server.received };
}

// The config passes the key on, so that a withheld key is what keeps it from the harness.
const PASS_THE_KEY = { env: ["BASETEN_API_KEY"] };

const compared = (alpha: string, beta: string): string[] => [
  "run",
  ...["--a", alpha, "--b", beta, "--model", "run-model"],
];

/**
 * Reads every file under a directory.
 * @param dir - The directory.
 * @returns The text of all its files, joined.
 */
const everythingIn = (dir: string): string =>
  fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      fs.readFileSync(path.join(entry.parentPath, entry.name), "utf8"),
    )
    .join("\n");

test("a decision check scores the expected value of the probabilities, with one request for each run", async () => {
  const { result, outDir, received } = await decided(
    [{ answers: ANSWERS }],
    CHECKS,
    compared,
  );
  expect(result.status, result.stderr).toBe(0);
  const results = readResults(outDir);
  expect(received, "one request for each of the two runs").toHaveLength(2);

  for (const record of results.records) {
    const [yes, no, kept, ruled] = record.checks;
    expect(yes?.score, "P(yes)").toBe(0.9);
    expect(yes?.probabilities?.["yes"]).toBe(0.9);
    expect(yes?.probabilities?.["no"]).toBeCloseTo(0.1);
    expect(no?.score, "1 - P(yes)").toBe(0.75);
    expect(
      kept?.score,
      "0.5 x 1 + 0.3 x 0.7 + 0.1 x 0.3 + 0.1 x 0",
    ).toBeCloseTo(0.74);
    expect(kept?.probabilities).toEqual({
      fully: 0.5,
      mostly: 0.3,
      partly: 0.1,
      "not at all": 0.1,
    });
    expect(ruled?.probabilities).toBeUndefined();
    expect(record.score, "(2 x 0.9 + 0.75 + 0.74 + 1) / 5").toBeCloseTo(0.858);
    expect(record.decision).toMatchObject({
      calls: 1,
      tokens: { input: 200, output: 3 },
      costUsd: null,
    });
    expect(record.judge).toBeNull();
  }
  expect(results.decisionModel).toBe(MODEL);
});

test("the decision model sees the task and the answer, and nothing about the subject", async () => {
  const { box, result, received } = await decided(
    [{ answers: ANSWERS }],
    CHECKS,
    compared,
  );

  expect(tableRow(result.stdout, "restate")).toMatch(
    /^\| restate \| 0\.86 \/ 0\.86 \(\+0\.00\) \(A 1 of 1 runs, B 1 of 1 runs\) \| too few runs \(A n=1, B n=1\) \| `decision "Is it plain\?" yes \(weight 2\)` A 0\.90 \(1 of 1 runs\), B 0\.90 \(1 of 1 runs\)<br>`decision "Does it mention weather\?" no` A 0\.75 \(1 of 1 runs\), B 0\.75 \(1 of 1 runs\)<br>`decision "How well is the meaning kept\?" fully\/mostly\/partly\/not at all` A 0\.74 \(1 of 1 runs\), B 0\.74 \(1 of 1 runs\)<br>`output_contains "fixed"` A 1\/1, B 1\/1 \| A 0%, B 0%(<br>A 0%, B 0%){3} \|/,
  );
  expect(result.stdout).toMatch(/^- Decision model: decider-one$/m);
  expect(result.stdout).toMatch(
    /^Decision model, in total and not counted in the table: 2 calls, duration [\d.]+ s, input tokens 400, output tokens 6$/m,
  );
  expect(result.stdout).not.toMatch(/^- Judge:|^Judge, in total/m);

  const [first, second] = received;
  expect(first).toMatchObject({
    method: "POST",
    url: "/v1/systemone",
    authorization: `Bearer ${KEY}`,
  });
  expect(first?.body).toEqual({
    model: MODEL,
    state: `<task>\nsay it in plain words\n</task>\n\n<answer>\n${ANSWER}\n</answer>`,
    questions: {
      q1: { type: "noul", instructions: "Is it plain?" },
      q2: { type: "noul", instructions: "Does it mention weather?" },
      q3: {
        type: "choice",
        instructions: "How well is the meaning kept?",
        criteria: {
          fully: null,
          mostly: null,
          partly: null,
          "not at all": null,
        },
      },
    },
  });
  expect(second?.body, "A and B are asked the same thing").toEqual(first?.body);
  const sent = JSON.stringify(received);
  for (const secret of [box.root, "plugin-", "claude-code", "run-model"]) {
    expect(sent).not.toContain(secret);
  }
});

test("the API key reaches neither the harness nor anything the command writes", async () => {
  const ran = await decided([{ answers: { q1: yesNo(1) } }], [PLAIN], () => [
    "score",
    "--subject",
    "none",
  ]);
  expect(ran.result.status, ran.result.stderr).toBe(0);
  const [record] = readResults(ran.outDir).records;
  expect(seenBy(String(record?.finalText)).leaks).toBe(0);
  expect(everythingIn(ran.outDir)).not.toContain(KEY);
  expect(ran.result.stdout + ran.result.stderr).not.toContain(KEY);

  // Without a decision check the variable is the user's own business, for example the key of the agent's provider.
  const box = sandbox();
  box.write(CONFIG_FILE, PASS_THE_KEY);
  const cases = plantCase(box, [{ type: "output_contains", text: "seed" }]);
  const outDir = path.join(box.root, "results");
  const flags = ["--subject", "none", "--cases", cases, "--out", outDir];
  await box.cli(["score", ...flags, "--reps", "1"], { BASETEN_API_KEY: KEY });
  const [plain] = readResults(outDir).records;
  expect(seenBy(String(plain?.finalText)).leaks).toBe(1);
});

test("an error body that echoes the key never reaches the reason or the results", async () => {
  for (const reply of [
    { status: 401, body: `bad key ${KEY}` },
    { body: `not json ${KEY}` },
  ]) {
    const ran = await decided([reply], [PLAIN], () => [
      "score",
      "--subject",
      "none",
    ]);
    const [record] = readResults(ran.outDir).records;
    expect(record?.checks[0]?.score).toBeNull();
    expect(everythingIn(ran.outDir)).not.toContain(KEY);
    expect(ran.result.stdout + ran.result.stderr).not.toContain(KEY);
  }
});

test("a non-JSON 200 body shows its start and never the key", async () => {
  const ran = await decided(
    [{ body: `<html>bad gateway ${KEY}</html>` }],
    [PLAIN],
    () => ["score", "--subject", "none"],
  );
  const [record] = readResults(ran.outDir).records;
  expect(record?.checks[0]?.reason).toMatch(
    /not valid JSON: <html>bad gateway \[redacted\]<\/html>/,
  );
  expect(everythingIn(ran.outDir)).not.toContain(KEY);
});

test("a failed request is sent once more, and its second answer counts", async () => {
  const { result, outDir, received } = await decided(
    [{ status: 500, body: '{"error": "overloaded"}' }, { answers: ANSWERS }],
    CHECKS,
  );
  expect(result.status, result.stderr).toBe(0);
  expect(received).toHaveLength(2);
  const [record] = readResults(outDir).records;
  expect(record?.score).toBeCloseTo(0.858);
  expect(record?.decision).toMatchObject({
    calls: 2,
    tokens: { input: 200, output: 3 },
  });
});

test("two unusable answers leave the decision checks without a score and the run invalid", async () => {
  const { result, outDir, received } = await decided(
    [{ answers: { ...ANSWERS, q2: yesNo(1.2) } }],
    CHECKS,
  );
  expect(result.status).toBe(EXIT.invalid);
  expect(received).toHaveLength(2);
  const [record] = readResults(outDir).records;
  const reason =
    'the decision model gave no usable answer: the probability of "yes" must be a number from 0 to 1, got 1.2';
  expect(record?.checks.map((check) => check.score)).toEqual([
    null,
    null,
    null,
    1,
  ]);
  expect(record?.checks[0]).toMatchObject({ reason });
  expect(record?.checks[0]?.probabilities).toBeUndefined();
  expect(record?.score).toBeNull();
  expect(record?.decision?.calls).toBe(2);
  expect(result.stdout).toContain(
    `- SUBJECT \`restate\` rep 1: a decision check has no score: ${reason}`,
  );
  expect(tableRow(result.stdout, "restate")).toMatch(
    /^\| restate \| n\/a \(0 of 1 runs\) \|/,
  );
});

test("a suite with a decision check does not start without the model, its key, and a usable URL", async () => {
  const box = sandbox();
  const server = await decisionServer([{ answers: { q1: yesNo(1) } }]);
  const cases = plantCase(box, [PLAIN]);
  const outDir = path.join(box.root, "results");
  const flags = ["--subject", "none", "--cases", cases, "--out", outDir];
  const score = (extra: string[], env: Record<string, string>) =>
    box.cli(["score", ...flags, "--reps", "1", ...extra], env);
  const key = { BASETEN_API_KEY: KEY };
  const model = [MODEL_FLAG, MODEL];

  const noModel = await score([URL_FLAG, server.url], key);
  expect(noModel.status).toBe(USAGE_ERROR);
  expect(noModel.stderr).toMatch(
    /no decision model is set: pass --decision-model or set decisionModel/,
  );
  const noKey = await score([...model, URL_FLAG, server.url], {});
  expect(noKey.status).toBe(USAGE_ERROR);
  expect(noKey.stderr).toMatch(/API key is not set: set BASETEN_API_KEY/);
  const emptyKey = await score(model, { BASETEN_API_KEY: "" });
  expect(emptyKey.status).toBe(USAGE_ERROR);
  const badUrl = await score([...model, URL_FLAG, "not a url"], key);
  expect(badUrl.status).toBe(USAGE_ERROR);
  expect(badUrl.stderr).toMatch(/the decision URL is not a URL: not a url/);
  expect(server.received).toHaveLength(0);
  expect(fs.existsSync(outDir), "no run started").toBe(false);

  box.write("skill-evals.config.json", {
    decisionModel: "decider-from-config",
    decisionUrl: server.url,
  });
  const configured = await score([], key);
  expect(configured.status, configured.stderr).toBe(0);
  expect(server.received[0]?.body.model).toBe("decider-from-config");
  expect(readResults(outDir).records[0]?.score).toBe(1);
});

test("a decision check of an invalid run is not sent to the model", async () => {
  const box = sandbox();
  const server = await decisionServer([{ answers: { q1: yesNo(1) } }]);
  const ghost = plugin(box, "plugin-ghost", { ghost: true, answer: ANSWER });
  const cases = plantCase(box, [PLAIN]);
  const outDir = path.join(box.root, "results");
  const flags = ["--cases", cases, "--reps", "1", "--out", outDir];
  const decision = [MODEL_FLAG, MODEL, URL_FLAG, server.url];
  const result = await box.cli(
    ["score", "--subject", ghost, ...flags, ...decision],
    { BASETEN_API_KEY: KEY },
  );
  expect(result.status).toBe(EXIT.invalid);
  const [record] = readResults(outDir).records;
  expect(record?.checks[0]).toMatchObject({
    score: null,
    reason: "not decided, because the run is invalid",
  });
  expect(record?.decision).toBeNull();
  expect(server.received).toHaveLength(0);
});
