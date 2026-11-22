import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { askApi } from "./judge-api.js";
import type { JudgeApi } from "./judge-api.js";
import { API_KEY, apiCase, judgedWith } from "./testing/judged.js";
import {
  failure,
  judgeServer,
  refusal,
  reply,
} from "./testing/judge-server.js";
import { plantCase, plugin } from "./testing/plant.js";
import { sandbox, seenBy } from "./testing/sandbox.js";

const RUBRIC = "It names the fix.";
const SCORE_HALF = '{"reason": "ok", "score": 0.5}';
const USAGE_ERROR = 2;
const SECRET_VAR = "JUDGE_TEST_KEY";
const IMAGE = "shot.png";

const config = (url: string, more: Partial<JudgeApi> = {}): JudgeApi => ({
  kind: "anthropic",
  url,
  model: "m-1",
  keyVar: "ANTHROPIC_API_KEY",
  timeoutMs: 5000,
  fallbacks: true,
  env: { ANTHROPIC_API_KEY: API_KEY },
  ...more,
});

test("the api path sends no harness process", async () => {
  const { run, received, box } = await apiCase({ rubric: RUBRIC }, [
    reply(SCORE_HALF),
  ]);
  const { ran, check } = await run();
  expect(ran.status, ran.stderr).toBe(0);
  expect(received).toHaveLength(1);
  expect(check?.score).toBe(0.5);
  // One start is the agent under test; a judge in a harness would be a second.
  expect(fs.readFileSync(box.started, "utf8").trim().split("\n")).toHaveLength(
    1,
  );
  expect(fs.existsSync(path.join(box.root, "fake/judge/prompts.jsonl"))).toBe(
    false,
  );
});

test("sends the key header", async () => {
  const { run, received } = await apiCase({ rubric: RUBRIC }, [
    reply(SCORE_HALF),
  ]);
  await run();
  const [first] = received;
  expect(first).toMatchObject({ method: "POST", url: "/v1/messages" });
  expect(first?.headers).toMatchObject({
    "x-api-key": API_KEY,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
    "anthropic-beta": "server-side-fallback-2026-07-01",
  });
  const body = first?.body;
  expect(body).toMatchObject({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    fallbacks: "default",
  });
  for (const key of ["thinking", "temperature", "top_p", "top_k"]) {
    expect(body).not.toHaveProperty(key);
  }
  const [message] = body?.messages ?? [];
  expect(message?.role).toBe("user");
  expect(message?.content).toHaveLength(1);
  expect(String(message?.content[0]?.text)).toMatch(/^Grade one answer/);
});

test("judgeModel, judgeFallbacks and the key variable come from the config file", async () => {
  const { run, received } = await apiCase(
    { rubric: RUBRIC },
    [reply(SCORE_HALF)],
    {
      config: {
        judgeModel: "my-judge",
        judgeFallbacks: false,
        judgeKeyVar: SECRET_VAR,
        env: [SECRET_VAR],
      },
    },
  );
  const { ran } = await run([], { [SECRET_VAR]: "other-key" });
  expect(ran.status, ran.stderr).toBe(0);
  const [first] = received;
  expect(first?.headers["x-api-key"]).toBe("other-key");
  expect(first?.headers).not.toHaveProperty("anthropic-beta");
  expect(first?.body).not.toHaveProperty("fallbacks");
  expect(first?.body.model).toBe("my-judge");
});

test("a missing key stops the command before any run", async () => {
  const { run, received, box } = await apiCase({ rubric: RUBRIC }, [
    reply(SCORE_HALF),
  ]);
  const { ran } = await run([], {});
  expect(ran.status).toBe(USAGE_ERROR);
  expect(ran.stderr).toMatch(/judge API key is not set: set ANTHROPIC_API_KEY/);
  expect(received).toHaveLength(0);
  expect(fs.existsSync(box.started)).toBe(false);
});

test("a suite with no judge check needs no key", async () => {
  const box = sandbox();
  const owned = plugin(box, "plugin-owned", { answer: "It is fixed now." });
  const cases = plantCase(box, [{ type: "output_contains", text: "fixed" }]);
  const ran = await box.cli(
    [
      ...["score", "--subject", owned, "--cases", cases, "--reps", "1"],
      ...["--out", `${box.root}/o`, "--judge-api", "anthropic"],
    ],
    {},
  );
  expect(ran.status, ran.stderr).toBe(0);
});

test("the key variable is withheld from the agent unless it is the harness's own login", async () => {
  const { run } = await apiCase({ rubric: RUBRIC }, [reply(SCORE_HALF)], {
    config: { judgeKeyVar: SECRET_VAR, env: [SECRET_VAR] },
    answer: null,
  });
  const withheld = await run([], { [SECRET_VAR]: API_KEY });
  expect(withheld.ran.status, withheld.ran.stderr).toBe(0);
  expect(seenBy(String(withheld.record?.finalText)).leaks).toBe(0);

  const own = await apiCase({ rubric: RUBRIC }, [reply(SCORE_HALF)], {
    answer: null,
  });
  const kept = await own.run();
  // ANTHROPIC_API_KEY is Claude Code's own login, so the agent already has it.
  expect(seenBy(String(kept.record?.finalText)).leaks).toBe(1);
});

test("--judge-harness is ignored with a one-line warning", async () => {
  const { run, received } = await apiCase({ rubric: RUBRIC }, [
    reply(SCORE_HALF),
  ]);
  const { ran } = await run(["--judge-harness", "claude-code"]);
  expect(ran.status, ran.stderr).toBe(0);
  expect(received).toHaveLength(1);
  expect(ran.stderr).toMatch(
    /skill-evals: warning: --judge-harness is ignored, because judgeApi is set\n/,
  );
});

test("the same-model warning compares the judge model with the model under test", async () => {
  const { run } = await apiCase({ rubric: RUBRIC }, [reply(SCORE_HALF)]);
  const same = await run(["--model", "claude-opus-5-5"]);
  expect(same.ran.stderr).toMatch(/the judge is the model under test/);
  const other = await run(["--model", "claude-haiku-4-5"]);
  expect(other.ran.stderr).not.toMatch(/the judge is the model under test/);
});

test("an unknown judgeApi, an empty url and a bad timeout are usage errors", async () => {
  const { run } = await apiCase({ rubric: RUBRIC }, [reply(SCORE_HALF)]);
  const kind = await run(["--judge-api", "openai"]);
  expect(kind.ran.status).toBe(USAGE_ERROR);
  expect(kind.ran.stderr).toMatch(/judgeApi must be "anthropic"/);
  const timeout = apiCase({ rubric: RUBRIC }, [], {
    config: { judgeTimeout: 0 },
  });
  const zero = await (await timeout).run();
  expect(zero.ran.status).toBe(USAGE_ERROR);
  expect(zero.ran.stderr).toMatch(/judgeTimeout must be a positive integer/);
});

test("a rate limit is tried once more, and the second answer counts", async () => {
  const { run, received } = await apiCase({ rubric: RUBRIC }, [
    failure(429, "slow down"),
    reply(SCORE_HALF),
  ]);
  const { check } = await run();
  expect(received).toHaveLength(2);
  expect(check?.score).toBe(0.5);
});

test("a refusal is no answer, and names its category", async () => {
  const { run } = await apiCase({ rubric: RUBRIC }, [refusal("cyber")]);
  const { check, ran } = await run();
  expect(check?.score).toBeNull();
  expect(check?.reason).toMatch(/refused.*cyber/);
  expect(ran.status).not.toBe(0);
});

test("a 400 gives the API's message, cut to 200 characters", async () => {
  const { run } = await apiCase({ rubric: RUBRIC }, [
    failure(400, `bad ${"x".repeat(300)}`),
  ]);
  const { check } = await run();
  expect(check?.score).toBeNull();
  const reason = String(check?.reason);
  expect(reason).toMatch(/HTTP 400: bad x/);
  expect(reason).not.toContain("x".repeat(201));
});

test("the judge usage sums every kind of input token", async () => {
  const { run } = await apiCase({ rubric: RUBRIC }, [
    reply(SCORE_HALF, {
      input_tokens: 10,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 30,
      output_tokens: 7,
    }),
  ]);
  const { record } = await run();
  expect(record?.judge).toMatchObject({
    calls: 1,
    tokens: { input: 60, output: 7 },
    costUsd: null,
  });
});

test("an image file named in files is sent as an attachment before the text", async () => {
  const { run, received } = await apiCase(
    { rubric: RUBRIC, sees: ["final", "files"], files: [IMAGE, "notes.txt"] },
    [reply(SCORE_HALF)],
    {
      plant: (box) => box.write(`cases/restate/workspace/${IMAGE}`, "PNGDATA"),
    },
  );
  await run();
  const content = received[0]?.body.messages[0]?.content ?? [];
  expect(content).toHaveLength(2);
  expect(content[0]).toEqual({
    type: "image",
    source: {
      type: "base64",
      media_type: "image/png",
      data: Buffer.from("PNGDATA").toString("base64"),
    },
  });
  expect(content[1]?.type).toBe("text");
  expect(String(content[1]?.text)).toContain(
    `<file path="${IMAGE}">attached as an image</file>`,
  );
  expect(String(content[1]?.text)).toContain("planted");
});

test("an image that is too large or of another type stays named and not shown", async () => {
  const { run, received } = await apiCase(
    {
      rubric: RUBRIC,
      sees: ["files"],
      files: ["big.png", "pic.bmp"],
    },
    [reply(SCORE_HALF)],
    {
      plant: (box) => {
        box.write(
          "cases/restate/workspace/big.png",
          "x".repeat(5 * 1024 * 1024 + 1),
        );
        box.write("cases/restate/workspace/pic.bmp", "BM");
      },
    },
  );
  await run();
  const content = received[0]?.body.messages[0]?.content ?? [];
  expect(content).toHaveLength(1);
  expect(String(content[0]?.text)).toContain(
    '<file path="big.png">not shown (image)</file>',
  );
  expect(String(content[0]?.text)).toContain(
    '<file path="pic.bmp">not shown (image)</file>',
  );
});

test("on the harness path an image is listed by name and not shown", async () => {
  const { prompts } = await judgedWith(
    { rubric: RUBRIC, sees: ["files"], files: [IMAGE] },
    [SCORE_HALF],
    {
      plant: (box) => box.write(`cases/restate/workspace/${IMAGE}`, "PNGDATA"),
    },
  );
  expect(prompts[0]).toContain(
    `<file path="${IMAGE}">not shown (image)</file>`,
  );
});

test("askApi reads the text blocks and ignores thinking", async () => {
  const { url } = await judgeServer([reply("hello")]);
  const answer = await askApi(config(url), "p", []);
  expect(answer).toMatchObject({ text: "hello", error: null });
  expect(answer.usage).toMatchObject({ tokens: { input: 100, output: 10 } });
});

test("askApi gives an error for a server error, a network error and a timeout", async () => {
  const { url } = await judgeServer([failure(503, "down")]);
  expect((await askApi(config(url), "p", [])).error).toMatch(/HTTP 503: down/);
  const dead = await askApi(config("http://127.0.0.1:1"), "p", []);
  expect(dead.error).toMatch(
    /request to http:\/\/127\.0\.0\.1:1\/v1\/messages failed/,
  );
  const slow = await judgeServer([{ hang: true }]);
  const late = await askApi(config(slow.url, { timeoutMs: 50 }), "p", []);
  expect(late.error).toMatch(/failed:.*timed out|failed:.*aborted/i);
});

test("askApi says so when the key is not set, the reply is no JSON, or the body has no text", async () => {
  const { url } = await judgeServer([{ body: "not json" }]);
  const none = await askApi(config(url, { env: {} }), "p", []);
  expect(none.error).toMatch(/judge API key is not set: set ANTHROPIC_API_KEY/);
  expect((await askApi(config(url), "p", [])).error).toMatch(/not JSON/);
  const empty = await judgeServer([{ body: "{}" }]);
  expect(await askApi(config(empty.url), "p", [])).toMatchObject({
    text: "",
    error: null,
  });
  const odd = await judgeServer([{ status: 500, body: "<html>" }]);
  expect((await askApi(config(odd.url), "p", [])).error).toMatch(
    /HTTP 500: <html>/,
  );
});
