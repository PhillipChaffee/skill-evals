import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { plantCase, script } from "./testing/plant.js";
import { readResults, sandbox } from "./testing/sandbox.js";

const YES = '{"score": 1, "reason": "yes"}';

/** What the fake judge logged for one call. */
interface Asked {
  argv: string[];
}

/**
 * Scores the planted case, with a judged check, once with and once without `--isolated`.
 * @param judgeInit - What the fake judge's init event is changed by (see the fake harness); none when absent.
 * @returns What the two commands did, and what the judge was started with each time.
 */
async function judgedBoth(judgeInit?: Record<string, unknown>) {
  const box = sandbox();
  box.write("fake/judge/replies.json", [YES, YES]);
  if (judgeInit) box.write("fake/judge/init.json", judgeInit);
  script(box, "ok", { turns: [[{ final: "done" }]] });
  const cases = plantCase(box, [{ type: "judge", rubric: "Says done." }]);
  const outDir = path.join(box.root, "results");
  const args = ["score", "--subject", "none", "--cases", cases, "--reps", "1"];
  const isolated = await box.cli([...args, "--out", outDir, "--isolated"]);
  const invalid = readResults(outDir).invalid;
  const plain = await box.cli([...args, "--out", path.join(box.root, "again")]);
  const asked = fs
    .readFileSync(path.join(box.root, "fake/judge/prompts.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Asked);
  return { isolated, plain, invalid, asked };
}

test("the judge session gets the isolation switches under --isolated and only then", async () => {
  const { isolated, plain, asked } = await judgedBoth();
  expect(isolated.status, isolated.stderr).toBe(0);
  expect(plain.status, plain.stderr).toBe(0);
  const [underFlag, withoutFlag] = asked.map((call) => call.argv);
  expect(underFlag).toContain("--strict-mcp-config");
  expect(underFlag?.[underFlag.indexOf("--setting-sources") + 1]).toBe("user");
  expect(withoutFlag).not.toContain("--strict-mcp-config");
});

test("a judge that reports something loaded invalidates an isolated run and names the judge", async () => {
  const { isolated, plain, invalid } = await judgedBoth({
    plugins: [{ name: "org", path: "/opt/org/plugin" }],
  });
  expect(isolated.status).toBe(1);
  expect(invalid[0]).toMatch(
    /the judge loaded outside the subject: \/opt\/org\/plugin$/,
  );
  expect(plain.status, plain.stderr).toBe(0);
});

test("a judge that does not report what it loaded invalidates an isolated run", async () => {
  const { isolated, plain, invalid } = await judgedBoth({ omit: ["plugins"] });
  expect(isolated.status).toBe(1);
  expect(invalid[0]).toMatch(
    /the judge harness did not report what it loaded$/,
  );
  expect(plain.status, plain.stderr).toBe(0);
});
