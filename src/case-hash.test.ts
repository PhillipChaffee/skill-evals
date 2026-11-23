import path from "node:path";
import { expect, test } from "vitest";
import { loadCases } from "./cases.js";
import { caseHash, runKey } from "./run-key.js";
import type { RunPlan } from "./run-plan.js";
import { sandbox } from "./testing/sandbox.js";

// Pinned from the code before turns existed (fe759f0): a single-prompt case keeps its case hash and run key, so that
// `diff` and `--resume` still know the results of earlier versions. The run key holds the package version, so it is
// pinned again at each release: the 0.1.0 value below differs from the 0.0.1 value only by that version.
const PINNED_CASE_HASH =
  "6fbfa37ca8f98b81dff3fe91276250b03ca8c5bca5ca88bb58d11faef9546f5c";
const PINNED_RUN_KEY =
  "e5fb24fd048fc983e3b1f6afb348f19d548b70847e0ae2b549c2fbdaf336e00e";

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
