import path from "node:path";
import { expect, test } from "vitest";
import { EXIT } from "./exit-codes.js";
import { plugin, script } from "./testing/plant.js";
import { readResults, sandbox } from "./testing/sandbox.js";

const ORG_PLUGIN = "/opt/org/plugin";
const FIRST = "do talk, first\n";

/**
 * Scores a two-turn case under `--isolated`.
 * @param subject - The subject: a plugin directory, or "none".
 * @param box - The sandbox, which holds the script.
 * @returns The command's result and what it wrote.
 */
async function isolated(subject: string, box: ReturnType<typeof sandbox>) {
  box.write("cases/talk/one.md", FIRST);
  box.write("cases/talk/two.md", "the follow-up\n");
  box.write("cases/talk/case.json", {
    checks: [{ type: "output_contains", text: "two" }],
    turns: [{ prompt: "one.md" }, { prompt: "two.md" }],
  });
  const out = path.join(box.root, "results");
  const result = await box.cli([
    ...["score", "--subject", subject, "--reps", "1", "--isolated"],
    ...["--cases", path.join(box.root, "cases"), "--out", out],
  ]);
  return { result, ...readResults(out) };
}

test("under --isolated, an extra plugin that only the second turn's process loads invalidates the run", async () => {
  const box = sandbox();
  script(box, "talk", {
    inits: [{}, { plugins: [{ name: "org", path: ORG_PLUGIN }] }],
    turns: [[{ final: "one" }], [{ final: "two" }]],
  });
  const { result, records, invalid } = await isolated("none", box);
  expect(result.status).toBe(EXIT.invalid);
  expect(invalid[0]).toMatch(/loaded outside the subject: \/opt\/org\/plugin/);
  expect(records[0]?.score).toBeNull();
  expect(records[0]?.unexpected).toEqual([ORG_PLUGIN]);
});

test("under --isolated, a second turn's process that does not load the subject invalidates the run", async () => {
  const box = sandbox();
  const subject = plugin(box, "plugin-owned", {});
  script(box, "talk", {
    inits: [{}, { plugins: [] }],
    turns: [[{ final: "one" }], [{ final: "two" }]],
  });
  const { result, records, invalid } = await isolated(subject, box);
  expect(result.status).toBe(EXIT.invalid);
  expect(invalid[0]).toMatch(/did not load the subject/);
  expect(records[0]?.subjectLoaded).toBe(false);
  // The first process loaded it, and the record's own report is the first's.
  expect(records[0]?.loaded.paths).toHaveLength(1);
});

test("a run whose every process reports the subject and nothing else is valid", async () => {
  const box = sandbox();
  const subject = plugin(box, "plugin-owned", {});
  script(box, "talk", { turns: [[{ final: "one" }], [{ final: "two" }]] });
  const { result, records } = await isolated(subject, box);
  expect(result.status, result.stderr).toBe(0);
  expect(records[0]).toMatchObject({ subjectLoaded: true, unexpected: [] });
});
