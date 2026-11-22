import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { API_KEY, apiCase } from "./testing/judged.js";
import { failure, reply } from "./testing/judge-server.js";

const RUBRIC = "It names the fix.";
const SCORE_HALF = '{"reason": "ok", "score": 0.5}';

test("a server error is tried once more through the judge, and the second answer counts", async () => {
  const { run, received } = await apiCase({ rubric: RUBRIC }, [
    failure(500, "overloaded"),
    reply(SCORE_HALF),
  ]);
  const { check } = await run();
  expect(received).toHaveLength(2);
  expect(check?.score).toBe(0.5);
});

test("a judgeUrl with trailing slashes still posts to /v1/messages", async () => {
  const { evaluated, received, url } = await apiCase({ rubric: RUBRIC }, [
    reply(SCORE_HALF),
  ]);
  await evaluated({ judgeUrl: `${url}//` });
  expect(received[0]?.url).toBe("/v1/messages");
});

test("a judge URL that is not a URL is a usage error before any run", async () => {
  const { evaluated, received } = await apiCase({ rubric: RUBRIC }, []);
  await expect(evaluated({ judgeUrl: "" })).rejects.toThrow(
    /the judge URL is not a URL/,
  );
  expect(received).toHaveLength(0);
});

test("an error body that echoes the key never reaches the reason or results.json", async () => {
  const echoed = failure(401, `bad key ${API_KEY} in ${API_KEY}`);
  const { run, out } = await apiCase({ rubric: RUBRIC }, [echoed]);
  const { check, ran } = await run();
  expect(check?.reason).toMatch(
    /HTTP 401: bad key \[redacted\] in \[redacted\]/,
  );
  const written = fs.readFileSync(path.join(out, "results.json"), "utf8");
  expect(written).not.toContain(API_KEY);
  expect(ran.stdout + ran.stderr).not.toContain(API_KEY);
});

test("a reply cut at max_tokens is unusable and is never parsed", async () => {
  const { run } = await apiCase({ rubric: RUBRIC }, [
    { text: SCORE_HALF, stopReason: "max_tokens" },
  ]);
  const { check } = await run();
  expect(check?.score).toBeNull();
  expect(check?.reason).toMatch(/the judge reply was cut at max_tokens/);
});

test("a reply with no text block says so", async () => {
  const { run } = await apiCase({ rubric: RUBRIC }, [{}]);
  const { check } = await run();
  expect(check?.reason).toMatch(/the judge reply has no text/);
});
