import path from "node:path";
import { expect, test } from "vitest";
import { loadCases } from "./cases.js";
import { caseHash, runKey } from "./run-key.js";
import type { RunPlan } from "./run-plan.js";
import { sandbox } from "./testing/sandbox.js";

// Pinned from the code before turns existed (fe759f0): a single-prompt case keeps its case hash and run key, so that
// `diff` and `--resume` still know the results of earlier versions.
const PINNED_CASE_HASH =
  "6fbfa37ca8f98b81dff3fe91276250b03ca8c5bca5ca88bb58d11faef9546f5c";
const PINNED_RUN_KEY =
  "ea01e856af86bbf7853a80f4cb236010058d1e7145a6db4bc5f7f878adda0222";

test("a single-prompt case keeps the case hash and run key it had before turns", () => {
  const box = sandbox();
  box.write("cases/solo/prompt.md", "say hello\n");
  box.write("cases/solo/workspace/a.txt", "a\n");
  box.write("cases/solo/case.json", {
    checks: [{ type: "output_contains", text: "hello" }],
    tags: ["one"],
  });
  const [caseDef] = loadCases(path.join(box.root, "cases"));
  if (!caseDef) throw new Error("no case");
  const plan = {
    caseDef,
    subject: { revision: "rev-1" },
    harness: { id: "claude-code" },
    bin: "/nonexistent/claude",
    rep: 1,
    judge: { harness: { id: "claude-code" }, bin: "/nonexistent/claude" },
  } as unknown as RunPlan;
  expect(caseHash(caseDef)).toBe(PINNED_CASE_HASH);
  expect(runKey(plan)).toBe(PINNED_RUN_KEY);
});
